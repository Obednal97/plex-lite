# Home server helper plugins: What's coming and Subtitles

Three bundled plugins work with the **home server helper**, a small service on your home server in
front of Sonarr, Radarr, Bazarr and Overseerr (setting it up: [HELPER.md](HELPER.md)). Plex Lite never
talks to Sonarr, Radarr or Bazarr itself and never holds their API keys: it asks the helper.

| Plugin | Folder | What it adds |
|---|---|---|
| Home server helper | `plugins/home-helper/` | Settings → Plugins → **Home server helper**: the address and its status. `PL.homeHelper` for the other plugins. |
| What's coming | `plugins/whats-coming/` | "New episodes this week" and "Films arriving soon" on Recommended; "3 episodes missing" and **Search for missing episodes** on a show. |
| Subtitles | `plugins/bazarr/` | **Subtitles…** on films and episodes: find missing subtitles, fix their timing; a "No English subtitles" badge. |

Each can be switched off under Settings → Plugins. Everything hides itself while the helper (or the
service behind a feature) isn't available, so nothing shows until the helper is set up.

## Home server helper

Settings → Plugins → **Home server helper** takes the helper's address with the TV keyboard:
`homeserver.local` becomes `http://homeserver.local:8787` (port 8787 unless you type another; a path
is kept, for a helper behind a reverse proxy). The row shows the status from `GET /healthz`:
"Connected · Sonarr, Radarr, Bazarr", "Can't reach the helper" or "Not set up". OK on it checks again
and opens a sheet to change or remove the address; it also says when the helper is in **dry run**
("Dry run: nothing is changed yet": searches and fixes only report what they would do) or paused.

If Overseerr's own "Download queue address" was set (an earlier version of the Overseerr plugin), it
is adopted once as the shared address and removed from Overseerr's settings. Overseerr's Downloading
reads `PL.homeHelper.url()` only: with no address, or the Home server helper plugin switched off, it
uses Overseerr's own download status.

**On the web** the helper is usually out of reach: it is plain `http` on your home network, and
browsers block `http` requests from an `https` page (`localhost` too: the web build's
Content-Security-Policy allows `https:` only). The row then says "Not available in this browser" and
the features stay hidden. The TV app (and a web build opened over `http` on your network, or a helper
behind `https`) can use it.

### `PL.homeHelper` (for bundled plugins)

| member | |
|---|---|
| `url()` | the address, or `null` (not set, or the plugin is off) |
| `health(maxAgeMs)` | `Promise<{ok, version, dryRun, paused, services: {seerr, sonarr, radarr, bazarr, plex}} \| null>`; cached a minute (failures 30 s), one request shared by every caller |
| `get(path, {timeout})` | `Promise<answer>`; rejects with `err.status` and `err.code` (`unauthenticated`, `rate_limited`, `not_found`, `bad_request`, `unavailable`, `upstream`, `internal`, `network`, `blocked`) |
| `post(path, body, ctx, {timeout})` | the same, with `X-Plex-Token` from `ctx.plexToken()` (the active profile) and a JSON body |
| `onChange(fn)` | `fn({url, health})` when the address or the `/healthz` answer changes; returns a function that stops it |
| `has(service)` | sync: was the service up at the last `/healthz` (for `actions`, which must answer at once) |
| `titleIds(ctx, item)` | a Plex item as the helper names it: `{type, tmdbId}` for films, `{type, tvdbId, season?, episode?}` for shows, seasons and episodes (a show's ids are looked up once per session) |
| `errorText(err, service)`, `busy(text)`, `idle()`, `dryRun(answer)` | plain messages, a toast with a spinner (`idle()` hides it), "did the helper only pretend" |
| `lru(max)`, `viewerKey()`, `isOwner()` | a bounded cache (`get/set/del/clear/size`); who is watching (the Plex Home profile, else the account), for caches of what Plex lets them see; the account owner (no profile picked, or the Home's admin) |

One `/healthz` goes out five seconds after start, so the first details page already knows what to
offer.

## What's coming

- **New episodes this week** (TV libraries' Recommended): episodes from `GET /coming?days=7` that
  aired in the last two days or air in the next seven, for shows that are in **this** library as the
  current Plex Home profile sees it (matched by TVDB id, else title and year, with one Plex title search
  per show, two at a time and none once the row has its 20 cards, cached for 30 minutes per profile). One
  card per show and day ("S2 E1–E8 · Friday"), with the show's own art from Plex and "S2 E5 · Tonight
  21:00", "Tomorrow 20:05", "Thursday", "Aired yesterday". A **Premiere** tag on season and series
  premieres, **New** on aired episodes that have a file. OK opens the episode once it has a file,
  otherwise the show.
- **Films arriving soon** (movie libraries' Recommended): Radarr's films with their date in the window,
  "Digital release Friday", "In cinemas tomorrow", "Disc release 6 Nov", or "Ready to watch" (tagged
  New) once downloaded. OK opens the film when it's in the library, otherwise a note with the date.
  Shown to the **account owner only** (no Plex Home profile picked, or the Home's admin profile): the
  films aren't in Plex yet, so Plex can't say whether a restricted profile may see them, and checking
  their ratings against a profile's limits would need another lookup per film.
- **Missing episodes** (a show's or season's details page): a "3 episodes missing" badge from
  `GET /missing` (aired, monitored episodes without a file; specials only on their own season page)
  and **Search for missing episodes** (`POST /missing/search`, the whole show or that season). The
  toast says what happened: "Searching for 3 missing episodes", "Nothing missing to search for", or in
  a dry run "Dry run: the helper would search for 3 episodes". The action hides once the cached answer
  says nothing is missing, or that Sonarr doesn't have the show.

Caching: `/coming` 15 minutes, `/missing` 5 minutes per show (the 200 most recent shows), library
matches 30 minutes (per profile, the 300 most recent). The rows go among Plex's own (`at`), each
plugin's as soon as it answers, as every plugin shelf does.

## Subtitles

- **Subtitles…** (details pill and the hold-OK menu, on films and episodes) opens a sheet from
  `GET /subtitles`: the subtitles the title has ("English · Subtitle file", "Spanish · In the video
  file"), **Find Spanish subtitles** for each language its Bazarr profile wants and it lacks, and **Fix
  subtitle timing** for each subtitle *file* (Bazarr can't re-time subtitles inside the video).
- **Find** (`POST /subtitles/search` with the item's Plex `ratingKey`, so the helper can refresh it in
  Plex) shows "Finding English subtitles…" with a spinner (the helper waits up to 45 s), then "Found
  English subtitles · they're in Plex now", "… · restart playback to see them" (when the helper
  couldn't refresh Plex), or "Bazarr couldn't find any".
- **Fix subtitle timing** (`POST /subtitles/sync`): "Re-timing English subtitles · takes a minute or
  two".
- **Badge**: "No English subtitles" on a details page when a full (not forced, not SDH) profile
  language is missing. It uses the same cached `/subtitles` answer as the sheet: one helper request per
  title every three minutes (plus, for episodes, the show's ids once per session).

## Errors

The helper's errors become short messages: "The helper didn't accept your Plex sign-in" (401), "Too
many requests · try again in a few minutes" (429, 20 actions per 10 minutes), "Bazarr isn't available
on the helper right now" (503), "Bazarr answered the helper with an error" (502), "Bazarr doesn't know
this title" (404), "Couldn't reach the home server helper".

## Trying it

The demo server ([tools/demo](../tools/demo/README.md)) includes a fake helper at
`http://127.0.0.1:8930/helper` with a calendar, missing episodes and subtitles made from the demo
library. Tests: `node --test test/home-helper.test.mjs test/whats-coming.test.mjs test/bazarr.test.mjs`
(the plugins against the same fake helper, `tools/demo/helper.mjs`, on a local port).
