# Live TV Browse: design

Status: built on `feature/livetv-browse` (2026-10-28), not merged. Extends the Live TV v2 guide
([LIVETV-v2-design.md](LIVETV-v2-design.md)): the filter row (All, Favourites, Movies, Sports, News)
becomes a **Browse rail** of categories and channel families, with the other dimension as chips, plus
an **On now wall**. The grid, details panel, number entry, favourites and the live player are as
before.

## Why

The v2 guide is good for "what's on now" and poor at everything around it:

- **Five fixed filters** (All, Favourites, Movies, Sports, News) for a few hundred channels. Nothing for
  documentaries, kids, music or shopping, and "Movies" meant "Plex calls it a movie", which on an
  XMLTV guide is any programme without an episode number.
- **No channel families.** People think in brands (one broadcaster's sports channels, its film channels), and
  IPTV lineups are full of them, but there is no way to see one brand's channels together.
- **Surfing doesn't narrow.** CH+/CH− and the mini guide already follow the guide's filter, but with
  five coarse filters that rarely helps.
- **No overview.** A grid of six rows answers "what's on channel X", not "what sport is on right now".

## Research (summary)

How TV guides help people find channels (Sky Q, Sky Glass/Stream, Virgin TV 360, YouView/BT/EE,
Freely, Pluto TV, Samsung TV Plus, YouTube TV, Google TV, Channels DVR); full notes are in the project
notes, not in this repo.

1. **Single-select categories are the norm.** Everyone filters by one category; HD, +1 and Favourites
   are just more entries in the same list. Stacking exists only as rules set up once.
2. **The category list lives on the left** (Sky Q's sidebar, Sky Glass's Left, Google TV, Channels) or
   behind a colour key (YouView: Blue). Routes that are hidden or moved draw complaints, so the key is
   printed on screen.
3. **Counts next to each choice** (Google TV) tell you what you'll get before you go in.
4. **Nobody offers a brand filter.** Families come from channel numbering and channel-list headings;
   deriving them from names is our own addition.
5. **Filtering makes surfing work**: CH± stays inside the choice (YouView), and Sky Q filters the mini
   guide too.
6. **"On now" walls are common** (Sky Glass, Channels DVR, Freely, YouTube TV) and reuse the guide's
   categories.

Three options were drawn: A, a Browse rail with chips (Sky Q-style); B, one list in sections (Pluto
TV-style; can't do families); C, an On now wall. **The owner chose A, with C as the rail's "On now"
entry.**

## What the server offers (checked against a real Plex DVR on an IPTV proxy, 350 channels)

| Source | Finding | Used for |
|---|---|---|
| `/{provider}/grid` (already fetched in 3-hour blocks) | a film's XMLTV categories are on the airing as `Genre`; an episode's are on its **show**, so the grid shows none for episodes | films' categories |
| `/{provider}/metadata/<k1>,<k2>,…` | 40 shows per request (~40 KB with `excludeFields=summary`) with their `Genre` | episodes' categories: ~400–600 shows per 6 h of guide, 11–16 requests |
| `/{provider}/grid?type=4&show.genre=<ids>` | filters by the show's genre on the server (~100 KB per category per 3 h) | not used: one request per category per block, against one batch for all |
| Channel names | IPTV titles carry brand words ("ZX - ORBIT SPORTS GOLF") | families, and a fallback category |
| Lineup group titles (the proxy's M3U) | not visible to Plex, and specific to one proxy | not used |

Measured on that lineup on 2026-10-28, after its guide feed was repaired: ~226 of 350 channels with
something on now; 277 channels get a category (85 sport, 48 entertainment, 44 news, 38 documentaries,
34 movies, 17 kids, 6 shopping, 4 music, 1 religious), and the rest have no guide data and no telling
name; 22 families cover 169 channels. Against the proxy's own per-channel groups, where a group names a
genre, the derived category agrees for 80% of channels. Most of the rest are documentaries against
entertainment, which listings themselves file both ways.

## Rules (js/livetv-browse.js, tested in test/livetv-browse.test.mjs)

### Categories

Entertainment, Movies, Sport, News, Documentaries, Kids, Music, Shopping, Religious, in this order in
the rail; empty ones are hidden.

- **A programme's category** is the first rule any of its genres matches, in priority order: Kids
  (Children, Under 5, Cartoon…), Sport (Sport(s), Football, Tennis, Golf, Racing…), News (News,
  Business, Politics, World Affairs, Weather), Movies (Movie, Film, Feature), Music, Shopping
  (Shopping, Specialist), Religious, Documentaries (Factual, Nature, History, Science, "News &
  Documentary" on its own…), Entertainment (Comedy, Drama, Game Show, Soap, Lifestyle, Cooking,
  Sci-Fi…). "Feature" next to a factual tag is a documentary feature, not a film. Plex's own `movie`
  type is ignored: an XMLTV guide marks any programme without an episode number as a movie.
- **A channel's category** (one per channel, which keeps it stable) is the one with the most airtime
  in the loaded guide **plus** the airtime that earlier sessions saw. Each session saves "what was
  loaded now + half of what was saved", per server, so the rail has counts the moment it opens and a
  channel's category follows it over a few days without flipping with the time of day.
- **Teleshopping counts a quarter**: many general channels fill the small hours with it, so only a
  channel that sells all day is a shopping channel.
- **Wait for the shows.** While most of a channel's airtime still waits for its show genres, the
  partial tally (often just the teleshopping, whose genres are inline) is not used.
- **Less than an hour of categorised airtime:** words in the name decide (news, sport, kids, cinema,
  shop, music…), else the little airtime there is.
- **Relatives lend theirs** to channels nothing else describes: a +1 takes its channel's; a family
  member takes its sub-family's (or family's) when 2+ categorised members agree and they are at least
  60% of the categorised ones.
- **On now shelves** use the programme's own category (a film on an entertainment channel is under
  Movies), falling back to the channel's.

### Families

A generic rule on channel names, with no list of brands in the app:

1. Drop a group prefix (`ZX - `, `QV | `…) and trailing variant words (`HD`, `FHD`, `UHD`, `4K`, `SD`,
   `+1`, `EAST`/`WEST`, anything in brackets); split glued numbers (`NLT1` → `NLT 1`).
2. Upper-case the words; a plural is its singular when both are in the lineup (`SPORTS` = `SPORT`, so
   "Orbit Sport+ 1" joins "Orbit Sports"); skip `THE`, `CHANNEL`, `TV`, `NETWORK` at the start.
3. Family key = the first word, or the first two when the first has one or two letters (`GA WAVE`).
4. A family needs **3 different channels**: a channel's HD and +1 versions count once. Its label is
   the words all members share, in the most common spelling, cased like a mixed-case member writes
   them, else acronyms stay in capitals (NLT, ESPN) and other words get a capital (Orbit).
5. Sub-families: the next word, when 3 different members share it and it isn't a number (Orbit →
   Orbit Sports, Orbit Cinema; numbered siblings like "NLT 1, 2, 3" don't split).

Families are largest first in the rail, with their sub-families indented under them.

### The filter

The guide's filter is a rail choice (`fav`, `all`, `now`, `c:<category>`, `f:<family>`) plus an optional
refinement from the chips (the other dimension). The guide, the mini guide and CH+/CH− all use it. It
is saved per server; a choice that no longer exists (a family the lineup lost, Favourites emptied) falls
back to All.

## The rail (1920×1080)

| Element | Where | Notes |
|---|---|---|
| Scrim | full screen | ink at 62% over the guide (38% over the picture); the tab bar dims with it |
| Panel | left 0, 560 wide | `#1e1e21`, a hairline rim on the right; slides in 56 px over `--t-appear` |
| Title | left 96, top 56 | "Browse channels" 36/700; under it "350 channels · 226 showing now" 26 `--text-2` |
| List | left 96, top 158, 440 × 768 (12 rows) | rows 64 apart: label 30 (sub-families indented 40), count right in `--text-3`; section headings ("Categories", "Channel families") 22 px caps. The current choice sits on a `--fill` plate; the focus is one white plate that travels; the list scrolls to keep 4 rows above the focus, with fades at the clipped edges |
| Hints | left 96, bottom 44 | `OK Show` `Back Close` |

The guide behind follows the focused entry **after a 450 ms rest** (a guide redraw costs ~100 ms on
the TV, so it never runs between quick presses), without its focus plate. Over the picture there is no
preview: the choice opens the mini guide.

## Chips (the filter row, top 136)

`[≡ Sport] | All sport 85 · Orbit Sports 23 · Vista Sports 6 …`

- The first chip names the rail choice on a `--fill-hi` pill with a filter glyph; a hairline divides
  it from the rest. OK on it opens the rail.
- Then "All …" (no refinement) with the choice's count, then the refinements, each with a count:
  - a **category**'s families (the sub-family when a channel has one), largest first;
  - a **family**'s categories, in rail order;
  - **All channels** and **Favourites**: the categories, which keeps v2's one-press Movies/Sport/News.
- A refinement must hold 2+ channels and fewer than the whole choice.
- On the wall, the chips are its shelves; the chip follows the focused shelf.

## The On now wall (the rail's "On now")

The details, ruler and grid give way to shelves under the chip row (clip from 214):

| Element | Notes |
|---|---|
| Shelf | heading 34/700 with "36 on now" in `--text-3`; 416 apart; Favourites first, then categories in rail order |
| Card | 420×236 landscape, 448 apart: the programme's art (a channel logo standing in for art doesn't count), else a muted tint with the genre in spaced caps top right; the channel's logo plate top left; the title on the bottom scrim; a teal progress line |
| Caption | under the focused card only: "1601 Orbit Sports Main Event" 26/600, "44 min left · Next: …" 24 |

Cards exist only for the shelves near the focus (two each way), so art loads only there.

## The mini guide and the player

- The mini guide's heading names the filter it follows and its size: "MOVIES › ORBIT CINEMA 13 channels".
  Its hints: `OK Watch` `CH ± Page` `● Browse` `Back Close`.
- **Blue over the picture** opens the rail; a choice becomes the guide's filter, CH+/CH− and the mini
  guide switch to it, and the mini guide opens on it. Back from the player, the guide shows the same
  choice.
- **Number entry reaches every channel**, in the guide and the player; one outside the filter switches
  it to All channels.
- The banner and mini guide use the shared logo plates (`js/logos.js`): white logos get a dark plate.

## Remote

| Where | Key | Does |
|---|---|---|
| Guide | **Blue** | the Browse rail (also from the tab bar and the chips) |
| | Left on the first programme (nothing earlier) | the Browse rail |
| | Up on the first row | the chips |
| | 0–9 | channel number (switches to All when the channel is filtered out) |
| Chips | Left / Right, OK, Down | choose a refinement and go into the guide; OK on the first chip: the rail |
| Rail | Up / Down, CH+ / CH− | move, page 8; the guide behind follows after a rest |
| | OK, Right | apply: the first channel of the choice gets the focus |
| | Back, Left, Blue | close, putting back the filter that was there |
| | 0–9 | close, and the digit starts number entry |
| Wall | arrows | move between cards and shelves; Up from the first shelf: the chips |
| | OK, Play | watch: CH+/CH− surf that shelf |
| | Left on the first card | the Browse rail |
| | Yellow, hold OK | favourite, as in the guide |
| | Back | back to the guide as it was before On now |
| Player | Blue | the Browse rail over the picture |
| | Up / Down, CH+ / CH− | the mini guide and zapping stay inside the filter |

Blue used to toggle a developer frame-time overlay everywhere; it still does outside the Live TV tab
and the live player.

## Data and speed

- Nothing new blocks the guide's first paint. The show genres are looked up 1.2 s after a block
  arrives, the shows on now first, one request of 40 at a time with 150 ms between them; categories are
  worked out when the on-now shows are in and again at the end, and listeners hear only when one changed.
- Families are worked out again only when channel names change (every block rebuilds the channel list).
- The rail, chips and wall read one cached context (favourites, categories, families, on now), rebuilt
  when the guide data changes or the minute turns.
- Cost on the TV (LG 65UM7100, webOS 4.5): working out every category and family 65–80 ms (twice per
  block, in the background); the context afterwards 3 ms; the rail's entries 5 ms.

### Measured on the TV (key to second frame, 2026-10-28, 350 channels)

| Action | Time |
|---|---|
| Guide, first cells after opening the tab | 1.2 s (unchanged) |
| Blue → rail | 68–72 ms |
| Rail Up/Down at scanning speed | 20–43 ms (median 23) |
| Rail page (CH±) | 83–157 ms |
| Rail preview (after the rest) | ~38 ms JS + ~27 ms layout |
| Rail apply → guide | 149–158 ms |
| Chips Up / Left/Right / Down | 30 / 29–36 / 23 ms |
| Guide Up/Down inside a filter | 42–60 ms |
| Left at the start → rail | 74 ms |
| On now → wall | 192 ms (builds the shelves) |
| Wall Left/Right · Up/Down | 75–135 · 79–223 ms (the app's Recommended shelves on the same TV: 83–261 · 139–243) |
| Mini guide moves (filtered) | 69–97 ms |
| CH+ inside a filter → banner | 51–73 ms |
| Blue over the picture → rail | 117 ms; rail moves there 35–89 ms |

## Owner decisions

1. **Option A plus the On now wall** (2026-10-28), as drawn.
2. **Families need 3 different channels** (a channel's HD and +1 versions count once); +1 channels are
   listed in their family and counted. A minimum of 4 would drop 8 small families.
3. **One category per channel** for the rail and the guide; **On now shelves use the programme's own
   category**.
4. **The guide still opens on Favourites** whenever there are some (2026-10-27). Otherwise it opens on
   the last applied choice (category, family, its chip or On now); previews aren't saved, and a choice
   made over the picture becomes the guide's.

The calls in 2–4 were made by the builder from the research's recommendations; the owner can change
any of them.

## Not done

- Sky Glass's strip of on-now tiles in the rail (the guide behind previews instead).
- Day jumps, A–Z, rule-based or hand-made channel lists.
- IPTV group prefixes as choices (still an open question in the v2 spec; families cover most of it).
