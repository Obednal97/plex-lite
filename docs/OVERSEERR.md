# Overseerr plugin: requests, downloads and problem reports

`plugins/overseerr/` works with [Overseerr](https://overseerr.dev) and its successor
[Seerr](https://github.com/seerr-team/seerr) (same `/api/v1`; verified against Seerr 3.4.1). It talks
to Overseerr only, never to Sonarr, Radarr or a download client: those stay on the server's LAN.

| File | What it does |
|---|---|
| `seerr.js` | shared core (`PL.overseerr`): per-profile sessions, API calls, permission checks, Plex → Overseerr mapping, the download list and its cache |
| `report.js` | "Report a problem" |
| `downloads.js` | the Downloading screen, the Downloading shelf and the details badge |
| `plugin.js` | Settings, Search requests, `register()` |
| `service/service.js` | the webOS service that holds the Overseerr sessions (Node 0.12, ES5) |

## Sign-in follows the Plex profile

Overseerr's session cookie can't be used by the app (HttpOnly, SameSite=Lax), so the service signs
in with a Plex token (`POST /api/v1/auth/plex`) and keeps the cookie. It keeps **one session per
Plex Home profile** (`key`: `p-<profile uuid>`, or `o-<token fingerprint>` for the account owner),
so a request or a report is always made under the viewer's own Overseerr account.

- A profile signs in automatically once it has signed in on this TV before (sessions live in `/tmp`
  and are re-created after a reboot).
- The **first** sign-in for a profile is an explicit step: Settings → Overseerr → "Sign in as …".
  Overseerr matches the Plex account by id or email, and if it doesn't know it (and new Plex sign-ins
  are allowed) it **creates a new Overseerr user** with the default permissions. Doing that silently
  when someone switches profile would be surprising.
- Until a profile has signed in, the plugin shows nothing for it (no Overseerr search row, no
  Downloading shelf, no Report button).
- A config from version 1.0 (one session) is kept for the account owner only.

## Report a problem

Shown as a pill on details pages and in the hold-OK menu for movies, shows, seasons and episodes,
**only when the viewer's Overseerr account may create issues**: permission bits `ADMIN` (2),
`MANAGE_ISSUES` (1048576) or `CREATE_ISSUES` (4194304), read from `/api/v1/auth/me`, refreshed at most
every 10 minutes (or from Settings → Overseerr → "Signed in as …").

Flow (all glass sheets):

1. **Reason**: Poor video quality · Wrong audio language · Audio out of sync · Stutters or looks
   corrupt · Wrong film / Wrong episode · Subtitles missing or burned in · Something else… (asks for a
   few words with the TV keyboard).
2. **Which episodes** (TV only): just this episode / all of the season / the whole show; from a show
   or season page, a season then an episode.
3. **Confirm**: "Send report · S1 E6 · as <Overseerr user>". If the title already has an open issue
   for the same episodes, the row says when it was reported.
4. `POST /api/v1/issue {issueType, message, mediaId, problemSeason, problemEpisode}`. `mediaId` is
   Overseerr's own media id, found with the title's TMDB id (`lookup` service method). Shows that only
   carry a TVDB id in Plex are found through Overseerr's search.

Issue types: video quality and corrupt → 1 (video); audio language and sync → 2 (audio); subtitles →
3; wrong item and other → 4. The message starts with the reason in words (what notifications show)
and ends with one machine-readable line for server-side automation:

```
Wrong audio language

Reported from Plex Lite (S1 E6).
plexlite: reason=audio-language; scope=episode; season=1; episode=6; plex=<ratingKey>; file=<file name>
```

What happens next is up to the server: Overseerr sends its usual "issue reported" notifications, and a
helper can act on the webhook (e.g. blocklist the release, delete the file, search again, resolve).

## Downloading

- **Downloading screen** (Settings → Overseerr → Downloads, or OK on a Downloading card): one row per
  title with poster, title, episodes, a progress rail, "45% · 12 min left" and size. Shows group their
  episodes ("S1 E4–E6 · 3 episodes"). It refreshes every 10 s while it's open and stops when hidden.
  It opens at once with the list the shelf already loaded, then refreshes. OK opens the title in Plex
  when it's already in the library.
- **Downloading shelf** on each library's Recommended view (movies in movie libraries, shows in TV
  libraries), only when something is downloading; cards carry the progress bar and a percentage badge.
- **Details badge**: "Downloading 45%", "Almost ready", "Queued" or "Download stalled" on the meta line
  of a movie, show or episode that is in progress.

Source, in order:

1. **A download-queue helper**, when Settings → Overseerr → "Download queue address" is set: `GET
   <address>/queue` (read-only, CORS `*`), one row per Sonarr/Radarr queue record:
   `{version: 1, updatedAt, items: [{source, mediaType: 'movie'|'tv', tmdbId, tvdbId, title, year,
   season, episode, episodeTitle, releaseTitle, status, size, sizeLeft, timeLeftSeconds, eta,
   posterUrl, fanartUrl, …}]}`. This shows the full queue, including things nobody requested.
2. **Overseerr** otherwise (or when the helper fails): the service's `downloads` method reads
   `/api/v1/media?filter=processing|partial` (100 each) and the 30 most recently changed available
   titles, keeps those with `downloadStatus` (Overseerr syncs it from Sonarr/Radarr every minute),
   adds titles and posters (cached) and returns a compact list.

The list is cached for 20 s in the app (5 s in the service) and shared by the shelf, the badge and the
screen, so a details page costs no extra request once the list is warm.

## Service methods

All take `key` (the profile). Errors: `unauthenticated` (sign in again), `forbidden` (Overseerr
refused this Plex account), `network`, `bad_request`.

| method | params | answer |
|---|---|---|
| `login` | `url, plexToken, key` | `{user: {id, displayName, permissions}, url}` |
| `status` | `key` | `{signedIn, user?, url}` (never signs in) |
| `request` | `key, method, path, body` | `{status, data}` for `/api/v1<path>` on the signed-in server |
| `downloads` | `key` | `{items: [{mediaId, mediaType, tmdbId, tvdbId, ratingKey, title, year, posterPath, backdropPath, status, downloads: [{title, status, size, sizeLeft, timeLeft, eta, season, episode, episodeTitle}]}], at}` |
| `lookup` | `key, mediaType, tmdbId` | `{title, year, posterPath, media: {mediaId, status, ratingKey, tvdbId, downloads, issues: [open issues]} \| null}` |
| `logout` | `key` or `all: true` | `{}` |

Tests: `node test/overseerr.test.mjs` (plugin logic, and the service against a fake Overseerr).
