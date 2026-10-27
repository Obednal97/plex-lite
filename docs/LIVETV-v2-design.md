# Live TV v2: design

Status: built and merged into main (2026-10-27). Replaces the "On now" channel list and the
player's old live mode (a title over the VOD block, CH+/CH− only).

## Why

The first Live TV tab was a list of the channels airing something *right now*: logo, number, name, the
current programme with a progress line, and a lazily fetched "Next". On a real Plex DVR fed by an IPTV
proxy (a few hundred channels, three to four days of XMLTV guide data, one tuner) it falls short:

- **You can't see ahead.** Only now and next; nothing at 9 pm, nothing tomorrow.
- **Channels disappear.** A channel with no programme on air at this moment (a fifth of a typical IPTV
  lineup, often film and news channels without guide data) isn't listed at all, so it can't be watched.
- **No details.** No synopsis, no episode, no time left, no artwork for the focused programme.
- **"Next" pops in** row by row, two requests at a time, as you scroll.
- **Getting to a channel is slow:** no channel numbers, no favourites, 350 rows to scroll.
- **The player knows almost nothing about live:** a title, CH+/CH− with a 600 ms debounce, and OK to
  pause. No now/next, no programme progress, no way to look at other channels without leaving, no
  number entry, no last channel, no sign of being behind live after a pause, no way back to live.
- **Channel change races the tuner:** the old session was released and the new one tuned in the same
  instant; with one tuner the new tune can arrive first and be refused.

Research (Sky Q, Virgin TV 360, YouTube TV, Google TV, BBC iPlayer, Plex, Channels DVR, Apple TV):
`notes/livetv-research.md` in the project notes (not in this repo).

## What the server supports (checked against a real Plex Live TV/DVR, PMS 1.43)

| Feature | Finding | Used for |
|---|---|---|
| Lineup | `/{provider}/lineups/dvr/channels`: every enabled channel with number, title and logo URL | the channel list, including channels without guide data |
| Guide depth | `/{provider}/grid` answers 3–4 days ahead; ~1,100 airings per 3 h for 350 channels (~1.6 MB, or ~0.9 MB with `excludeFields`) | the grid, fetched in 3-hour blocks for all channels |
| Synopsis | not in the grid (we exclude it); `key` → `/metadata/<id>` has `summary` | the details panel, fetched once the focus rests |
| Categories | Plex's own Movies / Shows / Sports / News sections; genres on each programme | the filters |
| Pause buffer | the live HLS playlist keeps every segment since the tune (`TranscoderLivePruneBuffer`, 90 min by default): no `ENDLIST`, media sequence 0 | pause, Go live, and seeking *if the TV exposes a seekable range* (see below) |
| Recording | DVR present, `subscribe` feature, no recordings yet | not built (owner decision, below) |
| Tuners | the proxy advertises **one** tuner | release-then-tune; a busy tuner is reported in words |

Live TV/Threadfin session-ID rule (unchanged, see `js/screens/player.js`): Plex binds the tuned stream to the
`X-Plex-Session-Identifier` sent with `POST …/tune`; the decision and `start.m3u8` must reuse the consumer id
from the part key `/livetv/sessions/<uuid>/<id>/index.m3u8`, else "Failed to find consumer" and no segments.

## Goals

- A **real guide**: two hours across, six channels down, every channel in the lineup, the focused
  programme's details and art above, and it never waits on the network while you move.
- **Fast to a channel:** number keys everywhere, favourites, CH+/CH− paging, and Back to "now".
- **Live controls that are live, not VOD:** a channel banner on every zap (logo, number, programme, its
  progress, time left, what's next), CH+/CH−, numbers, last channel, a mini guide over the picture.
- **Honest about time:** when paused, say how far behind live you are and offer Go live.
- Same family as the rest of the app and player v2: the same bottom block and scrim, round icons,
  white-plate focus, keycap hints, lit-glass tiles, the tokens and motion of DESIGN.md.

## Non-goals

- Recording, series links, reminders (recording: not wanted, see owner decisions).
- Catch-up or "start over" before the tune (Plex has no catch-up; Start over appears only when the
  programme's start is inside the buffer, which is rare).
- Live video previews in the guide or picture-in-picture (one tuner, weak GPU).
- Day-jump UI, custom channel ordering, hiding channels, recents.

## Anti-goals (a failure even if it works)

- A guide that repaints large areas per key or builds hundreds of cells: rows and cells are virtualised.
- A guide that hides the video when you only wanted to peek at another channel (the mini guide keeps
  it playing).
- Waiting on a spinner to move the focus.
- VOD controls on a live stream: a seek bar that pretends there is a timeline to scrub.
- Tuning on every key press while browsing.

## The Live TV tab (1920×1080)

| Element | Where | Notes |
|---|---|---|
| Tab bar, filters | top 40 / 136 | filters: All · Favourites (once there is one) · Movies · Sports · News (those with matches now/next) |
| Details | left 96, top 222, 1180 wide | eyebrow (red LIVE pill when on now, number, channel, times, teal "25 min left" or "Starts in 10 min"), 48 px title, 26 px episode/year · genres, 2-line synopsis in `--reading` |
| Artwork | right 96, top 214, 400×225 | the programme's art, radius 14, fades in once the focus rests |
| Ruler | top 462 | "Today"/"Tomorrow" over the channels; half hours every 353 px; a teal pill with the time at the now line |
| Channels | left 96, 300 wide | logo on a light plate (dark until the logo loads), number 26/700, name 22; a teal ★ for favourites; the focused row's number and name light up |
| Grid | x 412–1824, top 506, rows 84 apart (76 px cells, 6 px gaps) | 2 hours across (11.8 px per minute), nothing before the current half hour; on-now cells a little lighter; cells too narrow for a word stay blank; a 2 px teal now line; a ground-coloured fade under the last row |
| Focus | | the focused cell is the white plate with dark text and the one soft shadow |
| Number entry | over the artwork | a lit-glass tile: digits at 84 px with dashes for the rest, the channel it is heading for under it |

A programme that started before the view keeps its title in sight (the label slides right inside its cell).
A channel without guide data gets one long "No guide information" cell, still focusable and watchable.

Data: the lineup plus the 3-hour block on now are fetched on open; the next block follows 1.5 s later and
more as you scroll right. Blocks are cached (`PL.liveGuide`, shared with the player), the block on now is
refetched after 30 minutes, and ended airings are dropped. The synopsis is fetched 350 ms after the focus rests.

### Remote (guide)

| Where | Key | Does |
|---|---|---|
| Grid | Up / Down | channel above / below, keeping the time (the programme on at that time, else the next) |
| | Left / Right | previous / next programme; the view scrolls in half hours when the focus leaves it |
| | CH+ / CH− | page up / down six channels |
| | OK, Play | watch the channel (from live, whatever programme is focused) |
| | Hold OK | Watch / Add to (Remove from) Favourites |
| | Yellow | add / remove the channel from Favourites |
| | 0–9 | channel number: jumps to the row (switching to All if the channel is filtered out) |
| | Back | back to now; again: the tab bar |
| | Up on the first row | the filters |
| Filters | Left / Right, OK, Down | choose, apply, into the grid · Up: the tab bar |
| Number entry | digits / OK / Back | type / go now / cancel. Commits on its own after 2 s, or 0.35 s once no other number starts with the digits. No exact match: the nearest higher number |
| Pointer | hover / click | hover focuses a programme, click watches; click a channel plate to watch it |

## The live player

Nothing on screen while watching. The VOD bottom block is not used for live; the live controls
(`js/screens/live-osd.js`) take every key.

**Banner** (any key, every zap, every tune; hides after 5 s while live and playing; stays while paused,
behind live, tuning or failed). Same scrim, eyebrow, 64 px title and round icons as player v2:

| Element | Where | Notes |
|---|---|---|
| Logo plate | left 96, bottom 222, 156×88 | the channel logo on a light plate |
| Eyebrow | left 280, bottom 288 | pill (red LIVE; grey TUNING, NO SIGNAL, or "−4:12" when behind) · number · channel · ★ |
| Title | left 280, bottom 214 | the programme (from the guide at once, from the tuner if the guide has none) |
| Round icons | right 96, bottom 214 | Go live (only when behind), Start over (only when the programme start is in a seekable buffer), Favourite, Channels, Last channel (when there is one). The focused icon names itself above it |
| Programme bar | left/right 96, bottom 168, 6 px | the programme from start to end: what has aired (white 30%), where you are (teal), the live edge (a white tick when behind). A knob only when the TV exposes a seekable range and the bar has focus |
| Times | bottom 112 | "21:00 – 22:00 · 25 min left" (or "· 4 min behind live"; a pause glyph when paused) · right: "Next 22:00 Late News" |
| Hints | left 96, bottom 44 | `▲▼ Channels` `0–9 Channel number` `OK Pause/Play` |

**Mini guide** (Up/Down while watching, Down from the banner, or the Channels icon): the channel list of the
guide's filter down the left over a wedge scrim, the picture playing on the right. 8 rows of 104 px; the focused row
is the white plate, three rows above it, four below; the list wraps. Each row: logo plate, number and name
("· Watching" in teal on the current channel), the programme on now, a short teal progress line, time left and
what's next. It closes after 15 s without a key.

**Number entry**: the same lit-glass tile, top right; commits as in the guide and tunes.

**Behind live.** The TV's `<video>` either exposes the live playlist as a seekable range (then Left/Right jump
−10 s / +30 s inside it, Go live seeks to the edge, Start over seeks to the programme's start when it is
inside) or it doesn't (then pausing still works, the time behind is counted, and Go live tunes the channel
again, which starts at the live edge). Which one the TV does is measured on the TV and noted below.

### Remote (live player)

| State | Key | Does |
|---|---|---|
| Watching | OK, Info, Left/Right* | the banner (*Left/Right jump −10 / +30 s when there is a seekable buffer) |
| | Up / Down | the mini guide on the current channel |
| | CH+ / CH− | next / previous channel: the banner shows it at once, the tune waits 600 ms for more presses |
| | 0–9 | channel number |
| | Red | last channel |
| | Yellow | favourite on/off |
| | Play/Pause, Play, Pause | pause / play (pausing falls behind live) |
| | FF / Rew | +30 / −10 s in a seekable buffer; without one FF goes live |
| | Back | leave the player (the guide focuses the channel you were on) |
| Banner | OK | pause / play |
| | Up | the icons · Left/Right between them · OK presses · Down: back |
| | Down | the mini guide |
| | Back | hide the banner |
| Mini guide | Up / Down (hold to run), CH+ / CH− | move (a page with CH) |
| | OK | watch that channel (the guide closes, the banner shows it) |
| | Back, Left | close |
| | Yellow, 0–9 | favourite the focused channel · number entry |
| Tuning / failed | every key above | still works: change channel, open the mini guide, type a number. Back leaves at once after a failed tune (the banner stays up to say why) |

Last channel = the channel that was playing before the current one (CH presses in quick succession count as one
change). The guide remembers the channel you were watching and focuses it when you come back.

## Tuner handling

`tune()` stops the old stream, releases the old tuner session (`DELETE /transcode/sessions/<uuid>`) and waits for the
answer (at most 2.5 s, also waiting for a tune still in flight) before `POST …/tune`. Plex frees the tuner a moment
after it answers the release, so a tune that comes back without a stream is tried again after 0.6, 1.2 and 2 s; after
that it says "The tuner is busy. Another Plex app may be watching live TV." A tune refused with an HTTP error says
"Couldn't tune Sports Arena. The tuner may be busy, or the channel is off air." Leaving the player releases the
session as before. CH+/CH− presses within 600 ms tune only the last channel, and none if they end where they began.

## Measured on the TV (LG 65UM7100, webOS 4.5, 2026-10-27, a 350-channel lineup)

- **Guide load:** first cells 1.2 s after opening the tab (lineup + the 3-hour block: ~1,200 programmes,
  0.5 s fetch, 130 ms parse); the next blocks load in the background (60–100 ms parse each). ~270 DOM nodes,
  29 cells, 10 rows at a time; JS heap 13 MB.
- **Key to second frame:** guide Up/Down 50–94 ms, Left/Right 55–85 ms (168 ms when a cell bucket is rebuilt,
  once per two hours of scrolling), CH page 108–119 ms, Back to now 85 ms, digits 31–57 ms. Live player: banner
  icons 35–65 ms, mini guide open 193 ms (first build of its rows), mini guide moves 60–87 ms, OK to tune 84–112 ms,
  CH+ to the new banner 62 ms, Red 77 ms, Back to the guide 266 ms.
- **Tune to picture:** 9–14 s, almost all of it the server's `POST …/tune` answering (7–11 s, the proxy starting the
  stream); decision 35 ms, first frame ~1.7 s after that. Not something the client can shorten.
- **Pause buffer:** the TV's `<video>` reports `duration` NaN and a seekable range from 0 that grows with the stream
  (since the tune), so pause, −10 s / +30 s jumps, Go live (seek to the edge) and Start over (when the programme
  started after the tune) all work by seeking; resuming after a pause plays on from where it paused.
- **Sessions:** after CH+, CH+ ×2, Red and a mini-guide tune, leaving the player left no live sessions on the server.

## Owner decisions (2026-10-27)

1. **Recording:** not wanted. Not built.
2. **Default filter:** the guide opens on Favourites whenever there are some; otherwise on the last filter used.

## Open questions for the owner

1. **Group prefixes.** IPTV titles like "UK - News One" are shown as "News One" when most channels carry such a prefix.
   Would you like the groups (UK, USA, sports…) as filters too?
2. **Tune time.** 9–14 s per channel change on your setup, nearly all in the server's tune call (the IPTV proxy
   starting the stream). The proxy's buffer settings may shorten it; the app can't.
3. **Buffer.** Plex keeps 90 minutes (`TranscoderLivePruneBuffer`). Forum reports say Plex's own players stall at
   that limit; pauses that long were not tested here. Go live always works.
