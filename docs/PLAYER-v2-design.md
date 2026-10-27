# Player v2: design

Status: approved for building (2026-10-27). Replaces the "row of labelled capsules" player from 0a7eede.

## Why

The first overhaul put a row of text pills (Pause, 10 s, 30 s, Subtitles, Chapters, Next episode) under the bar
and opened the subtitle list in a far corner. It works but reads as "buttons slapped on the bottom". The owner
wants the player to feel like the **Apple TV app's player first, Netflix second**. Research on what the best 10-foot
players do (tvOS, Netflix TV, Infuse, Disney+, Prime, Plex) led to the layout below.

## Goals

- Nothing on screen while watching; one calm bottom block when called up.
- The **bar is the main control**: Left/Right act straight away, no confirm step.
- Very few drawn controls. Play/pause and back are the remote's keys, not on-screen buttons.
- Subtitles and audio change **without leaving the video**, from a small menu next to its icon.
- Chapters, episodes and info are **tabs under the bar** (Down), not buttons.
- Skip Intro / Skip Credits and the end-of-episode card are single, obvious, already-focused buttons.

## Non-goals

- No picture-in-picture, no ratings row, no X-Ray/cast tab, no playback speed.
- No shrinking the video at the end of an episode (the video plane is hardware; scaling it is not worth the risk).
- No change to how streams are chosen, transcoded or reported.

## Anti-goals (a failure even if it works)

- A row of identical buttons or icons along the bottom (what we are replacing).
- Any seek that needs a second press to happen.
- Menus that cover the picture while it plays, or that open far from what opened them.
- Jank on the 2019 TV: Chrome 53, weak GPU. Transform/opacity only; no per-key repaint of large areas.

## Layout (1920×1080; tokens from DESIGN.md)

Mockups: the "Plex Lite player mockups" canvas (owner's private link). Each board's exact markup is the reference
for sizes and colours. Boards 1–4, 5a, 6, 7 are approved; 5b (one combined sheet) was rejected in favour of 5a.

Safe margins 96 px left/right. Bottom-up, with controls up and no tab open:

| Element | Where | Notes |
|---|---|---|
| Scrim | bottom 520 px | `linear-gradient(to top, ink 92% → 70% at 40% → 0)`; no solid bar |
| Tabs | left 96, bottom 44 | text tabs 26 px/600, `--text-3`; selected = `--fill-hi` pill; focused = white plate |
| Times | bottom 112, 26 px | left: elapsed in `--text`, then " · Chapter N" (chapter title from Plex) in `--text-2`; right: "−5:35 · Ends at 21:14" in `--text-2` |
| Bar | left/right 96, bottom 166 | 6 px; split into one segment per chapter (6 px gaps) when chapters exist; fill `--resume`; track white 30%. **Focused:** 10 px with a 28 px white head |
| Title block | left 96, bottom 214 | eyebrow 26 px `--text-2` (year, or "Show · S1 E2"), title 64 px/700 |
| Round icons | right 96, bottom 214, gap 20 | 68 px circles, white 14% + 1 px rim; focused = white plate, dark icon, scale 1.08. Order: Subtitles, Audio (only when there is more than one audio track), Next episode (episodes with a next) |

**Paused / scrubbing (board 2):** a 30% ink veil over the picture; the bar grows to 12 px; a 4 px teal tick marks the
real position; the part between real and target is white 75%. Under the bar: a pause glyph and
"Paused at 9:13 · jumping to Chapter 5"; right: remaining time at the target. Bottom-right key hints:
`[OK] Jump here` `[Back] Return to 9:13`. Icons and tabs hide while scrubbing.

Over the target rides a **time label**: the time at 48 px/700 with the target's chapter name (24 px, `--text-2`)
under it, on a dark plate (ink 84%, 1 px rim) with a small caret pointing at the head. There is no picture frame:
the owner's server does not generate video preview thumbnails (decided 2026-10-27, disk space), so this is the
normal look, not a fallback. Board 2's 464×261 thumbnail only appears on servers that do make them: the player
asks for Plex's index frame (`/library/parts/<id>/indexes/sd/<ms>`) only when the part advertises an `sd` index,
and then shows the frame (3 px white rim) over a small time pill instead.

**Subtitles / Audio menu (board 5a):** a lit-glass popover (DESIGN.md "Sheets") 540 px wide, anchored above its
icon with a small caret pointing at it; header in 22 px caps `--text-3`; rows 64 px (76 with a second line), focused
row = white plate; the current choice has a ✓. Subtitle rows: Off, then each track; picture-based (PGS/VobSub) tracks
get a second line "Picture subtitles · the server burns them in". Last row, after a hairline: "Size and style ›",
which swaps the list for Small / Medium / Large (stored like other settings). Audio rows: track name with
"5.1 surround · AC3" style second line. The video keeps playing; the bar and title stay visible behind.

**Tabs (boards 6 and 7):** choosing a tab slides the title, bar and times up (transform) to make room for a
210–260 px content row; the tab gets the `--fill-hi` pill. Tabs: **Info** (always), **Cast** (when there is cast data, added 2026-10-27),
**Chapters** (when chapters exist),
**Episodes** (episodes only: the current season as cards, current one marked "Now", like chapters).
- Chapters: 320×180 cards, gap 32 (five fill the width; the row scrolls beyond that), title + start time under each;
  the current chapter has a mini progress line and is where focus lands; focused card = 3 px white rim, scale 1.08,
  the shared shadow. Chapter thumbnails from Plex when present (a separate, optional server setting), else a plain
  card with the time large.
- Info: synopsis (28 px `--reading`, max ~1000 px wide), a "Start from the beginning" button, and a two-column
  facts list: Playing (Direct Play / Converting: reason), Video, Audio, Subtitles.
- Cast (the achievable cousin of Apple TV's InSight / Prime X-Ray; Plex has no per-scene data): the details
  page's round people cards at 160 px, 200 px apart (eight in view, made only as they come near it): photo or
  monogram, name, character, and "Guest star" in `--resume` for guests; focus = lit edge and the people scale.
  A movie lists its Roles. An episode lists its own Roles first, then the show's cast in billing order (the show's
  metadata is fetched once per show per session, after playback starts), one entry per person, at most 40. Plex
  often copies a show's leads onto each episode, so an episode role counts as a guest only when the show's cast is
  known and the person isn't in its top ten. OK on a person does nothing for now (no leaving mid-playback);
  Back / Up work as in the other tabs. Built lean for the TV: the cards are placed with `left` (no layer each),
  the circle is the only thing that scales and isn't an overflow clip, and the rows of the other tabs are made
  while the remote is idle with the tabs up, so switching to one only shows it.

**Skip Intro / Skip Credits (board 3):** controls hidden, a soft bottom-right radial scrim, one 80 px white pill
"⏩ Skip Intro" at right 96 / bottom 96 with a 5 px teal line along its bottom showing how much of the segment is
left. It is focused: OK presses it. If the controls are called up during the segment, the pill stays, moves up to
sit above the round icons, and keeps focus until the person moves away from it.

**End of episode (board 4):** at the credits marker (else the last 30 s) of an episode that has a next one:
bottom-right radial scrim; "UP NEXT · S1 E2", the next title (40 px/700), its runtime, and a 320×180 thumbnail; below,
"Watch Credits" (glass) and "▶ Next Episode in 8" (white, focused, teal countdown line). Countdown length: keep the
existing setting. Watch Credits or Back dismisses it and keeps playing. Movies and last episodes keep "Skip Credits".

## Remote

| State | Key | Does |
|---|---|---|
| Watching, controls hidden | Left / Right | show controls **and** jump −10 s / +30 s |
| | Up / Down / OK | show controls, focus on the bar (OK does not pause here) |
| | OK during intro/credits | press Skip |
| | Play/Pause (any time) | toggle |
| Bar focused, playing | Left / Right | jump −10 s / +30 s at once (repeat adds up) |
| | Hold Left / Right | scrub with preview (paused look); OK jumps, Back returns |
| | OK | pause (controls stay) |
| Bar focused, paused | Left / Right (and hold) | move the scrub target with preview; OK jumps and plays; Back returns |
| | Up | round icons · Down: tabs |
| Icons | Left / Right | between icons · OK opens its menu · Down: back to the bar |
| Menu open | Up / Down, OK | choose (closes the menu) · Back closes it |
| Tabs | Left / Right | switch tab · Down: into the cards · OK on a chapter seeks there, on an episode plays it · Up / Back: back to the bar |
| Any | Back | close the innermost thing; with only the controls up, hide them; with nothing up, leave the player |

Controls hide after 5 s without a key while playing. They stay while paused, scrubbing, or while a menu or tab is open.
The Magic Remote pointer keeps working: hovering focuses, clicking presses, clicking the bar seeks there.

Live TV keeps its current behaviour; it uses the same title block and scrim but no bar segments, tabs or scrubbing.

## Left to the builder

Component structure, animation timings within DESIGN.md's motion rules, and anything not stated above, keeping to the
anti-goals.
