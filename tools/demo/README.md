# Demo server

Runs Plex Lite on the desktop against a **mock Plex Media Server and plex.tv** with a small library
of openly licensed films: Blender open movies, public-domain classics and NASA shorts. Use it to
work on the UI without a Plex account or server, and to take screenshots that show nobody's real
library. Node 18 or later, no npm packages.

```sh
node tools/demo/fetch-media.mjs   # once: ~13 MB of artwork from Wikimedia Commons
node tools/demo/server.mjs        # http://127.0.0.1:8930
```

Open http://127.0.0.1:8930 in Chrome or Chromium at 1920x1080 (or zoom to fit) and use the arrow
keys, Enter and Escape (Back). Open http://127.0.0.1:8930/?signin to start signed out and see the
plex.tv/link screen; the demo "approves" the code after 30 seconds.

## What it does

| File | |
| --- | --- |
| `server.mjs` | Serves the app and answers the Plex endpoints the app calls: sections, hubs, metadata (extras, On Deck, markers, chapters), children, related, search, collections, genre/decade lists, first-letter counts (`firstCharacter`, for the A–Z rail), play queues, timeline and scrobble (watched state is kept in memory until restart), the Live TV guide, `/photo/:/transcode` and direct play. `/plextv/*` mocks plex.tv: user, Home users, resources and link-code pins. The page gets `window.PL_DEV` pointing the app at both. |
| `model.mjs` | Builds Plex-shaped metadata (`MediaContainer`, rating keys, tag ids, image paths, hubs, a repeating Live TV schedule) from `library.json`. |
| `library.json` | The content: titles, credits, summaries, collections, channels, which file each image and video comes from (with licence and author), and which titles `shots.mjs` uses. Generated from Wikimedia Commons metadata, then hand-edited. |
| `art.mjs` | SVG artwork for what has no free image: typographic posters, wordmark logos, channel badges, collection collages, and the blurred "ambient" backdrops Plex's transcoder would make. |
| `fetch-media.mjs` | Downloads the artwork (Commons thumbnails and video frames) into `~/.cache/plexlite/demo-media` (`PLEXLITE_DEMO_MEDIA`). Files are checked to be JPEG/PNG. `--videos` also keeps local copies of the videos (large). |
| `shots.mjs` | Takes the README screenshots with headless Chromium, driving the app with key presses. |
| `credits.mjs` | Writes `docs/screenshots/CREDITS.md` from `library.json`. |

Video plays straight from Wikimedia Commons (the server redirects to its VP9 WebM transcodes), so
the player needs a browser with VP9 (any recent Chrome or Chromium) and internet access. Titles
without artwork get generated posters until `fetch-media.mjs` has run.

Settings: `PORT` (8930), `PLEXLITE_DEMO_MEDIA`, `PLEXLITE_DEMO_LIVETV=0` (no Live TV tab) and
`PLEXLITE_DEMO_SEED` (repeatable `sort=random`, for Surprise Me and Shuffle).

Titles with a video advertise preview thumbnails: the server answers Plex's index-frame requests
(`/library/parts/<id>/indexes/sd/<ms>`) with frames from `PLEXLITE_DEMO_MEDIA/previews/<video>/<seconds>.jpg`
if you put some there, else with the title's backdrop for every time.

Each title has one placeholder subtitle track (timed "Demo captions" cues), and two Caminandes
episodes and Sintel carry intro markers and chapters, so Skip Intro and the Chapters tab can be
tried.

What it doesn't do: transcoding (everything direct plays), real subtitles, Live TV playback (the guide
works; tuning a channel fails), PIN-protected profiles, and the Overseerr plugin.

## Screenshots

```sh
npm i --prefix ~/.cache/plexlite-shots-tools playwright-core   # outside the repo
PLAYWRIGHT_DIR=~/.cache/plexlite-shots-tools CHROMIUM=/path/to/chrome-or-headless-shell \
  node tools/demo/shots.mjs [out-dir] [shot ...]
node tools/demo/credits.mjs > docs/screenshots/CREDITS.md
```

`shots.mjs` starts its own server on port 8931, waits for every image to load, and writes JPEGs when
ImageMagick (`magick`) is installed. Live TV and "Ends at" times follow the clock, so those differ
from run to run.

## Adding content

Only add works that are in the public domain or under CC BY / CC BY-SA, with images from Wikimedia
Commons (or another source with a clear free licence). No TMDB, IMDb or Plex artwork. Record each
image's file page, author and licence in `library.json` `media` and regenerate `CREDITS.md`.
Wikimedia only serves thumbnails at its standard widths (250, 330, 500, 960, 1280, 1920 ...), and
video frames as `<width>px-seek=<seconds>-<file>.jpg`.
