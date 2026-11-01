# Overseerr plugin: requests, downloads and problem reports

`plugins/overseerr/` works with [Overseerr](https://overseerr.dev) and its successor
[Seerr](https://github.com/seerr-team/seerr) (same `/api/v1`; verified against Seerr 3.4.1). It talks
to Overseerr only, never to Sonarr, Radarr or a download client: those stay on the server's LAN.

| File | What it does |
|---|---|
| `seerr.js` | shared core (`PL.overseerr`): per-profile sessions, API calls, permission checks, Plex → Overseerr mapping, the download list and its cache |
| `report.js` | "Report a problem" |
| `downloads.js` | the list screen (Downloading, Your requests), the Downloading shelf and the details badge |
| `discover.js` | Trending, Popular and Upcoming rows (Recommended, Search before typing) |
| `screens.js` | the TV's Overseerr page and Your requests |
| `plugin.js` | the page's rows, requests (Search, discover, Request seasons), `register()` |
| `touch.js`, `touch.css` | the same pages on phones and tablets (web build only) |
| `service/service.js` | the webOS service that holds the Overseerr sessions (Node 0.12, ES5) |
| `seerr-web.js` | the web build's browser path: the same methods as the service, with `fetch` from the page (see [On the web](#on-the-web)) |

## Sign-in follows the Plex profile

Overseerr's session cookie can't be used by the app (HttpOnly, SameSite=Lax), so the service signs
in with a Plex token (`POST /api/v1/auth/plex`) and keeps the cookie. It keeps **one session per
Plex Home profile** (`key`: `p-<profile uuid>`, or `o-<token fingerprint>` for the account owner),
so a request or a report is always made under the viewer's own Overseerr account.

- A profile signs in automatically once it has signed in on this TV before (sessions live in `/tmp`
  and are re-created after a reboot).
- The **first** sign-in for a profile is an explicit step: Settings → Overseerr (the page) → "Sign in as …".
  Overseerr matches the Plex account by id or email, and if it doesn't know it (and new Plex sign-ins
  are allowed) it **creates a new Overseerr user** with the default permissions. Doing that silently
  when someone switches profile would be surprising.
- Until a profile has signed in, the plugin shows nothing for it (no Overseerr search row, no
  Downloading shelf, no Report button).
- A config from version 1.0 (one session) is kept for the account owner only.

## The Overseerr page

Settings → Plugins → Overseerr opens a page (a TV screen in Settings' look; a touch page on phones
and tablets): who you're signed in as and whether you can report problems, **Your requests**,
**Downloads**, **Trending, Popular and Upcoming** (on/off, this device), Sign in again, Sign out of
Overseerr (this profile only), the Overseerr address, and, until the shared **Home server helper**
setting exists (`plugins/home-helper`, `PL.homeHelper`), the old "Download queue address". Before a
profile has signed in it offers "Sign in as …"; before Overseerr is set up, "Set up Overseerr".

## Your requests

The viewer's own requests, newest first (`GET /api/v1/request?take=50&skip=0&sort=added&filter=all&
requestedBy=<the session's Overseerr user id>`; the service always uses its own session's user, and
Overseerr itself limits users without "Manage requests" to their own). One row per request: poster,
title, the seasons ("Seasons 1–3", or the year and "Film"), when it was requested, and its state:

| State | When |
|---|---|
| Pending approval | the request is pending (1) |
| Declined / Failed | declined (3) / failed (4) |
| Available | completed (5, Seerr), or every requested season (a film: the title) is available |
| Downloading 45% | Sonarr/Radarr have it in their queue (Overseerr's `downloadStatus`), with a progress rail |
| Partly available | some requested seasons are in (a film or a request without seasons: the title is partly available) |
| Processing | approved and sent to Sonarr/Radarr (media status 3) |
| Approved | approved, nothing further yet |

Overseerr's request list doesn't load the media's seasons, so a show's states come from each season
request's status (Seerr marks a season request completed once it's in). OK opens the title in Plex
when Overseerr knows its Plex `ratingKey`, else its request sheet. The list refreshes every 30 s while
it's open and is cached for 20 s (the page shows the count from the same answer).

## Trending, Popular and Upcoming

Rows from Overseerr's discover lists, only when the plugin is on, this profile is signed in and the
switch on the Overseerr page is on:

| Where | Rows (and their place) | Lists |
|---|---|---|
| A movie library's Recommended | Trending films (after 2 Plex rows), Popular films (after 4), Upcoming films (after 6) | `/discover/trending?mediaType=movie`, `/discover/movies`, `/discover/movies/upcoming` |
| A TV library's Recommended | Trending shows, Popular shows, Upcoming shows (same places) | `/discover/trending?mediaType=tv`, `/discover/tv`, `/discover/tv/upcoming` |
| Search, before typing | Trending (films and shows alternately), Popular films, Popular shows | the same lists |

(The What's coming plugin's rows are "New episodes this week" and "Films arriving soon".) Titles in
the library (available or partly available, with a Plex `ratingKey` that the server confirms) open
their Plex page; the others open the request sheet. Cards carry the same badges as Search's request
row (Requested, Processing, Partly available, Downloading n%; shorter on phones). Overseerr versions
without trending's `mediaType` send both kinds; only the asked-for kind is kept. The service's
`discover` method sends 20 compact results per list (Overseerr's own answer is 50–100 KB), and the
app keeps each list for 30 minutes per profile, shared by Search and both libraries; a request made
from Plex Lite clears the affected caches.

## Request seasons

A show page (and a season page) of a show that's in Plex gets a "Request seasons" pill, and the
hold-OK menu a row, when Overseerr says some seasons have aired but are neither available nor in an
open (pending or approved) request. It opens the season request sheet ("Request all seasons",
"Request Seasons 4 and 5", then each season with its state, or "Starts 19 Jan 2027" for one that
hasn't aired). The lookup is the service's `lookup` with the show's seasons (a few hundred bytes),
cached for 10 minutes per show: the first visit answers as a promise (the details page adds the pill
when it lands, within 5 s; the hold-OK menu gets whatever is known within 450 ms and the lookup
carries on into the cache). Shows without a TMDB id in Plex are matched through Overseerr's search, as
for reports. A show Overseerr can't match is kept as "nothing to request"; a lookup that failed for a
reason that may pass (no network, a session that ended, Plex not answering) isn't kept, so the next
visit asks again.

## Report a problem

Shown as a pill on details pages and in the hold-OK menu for movies, shows, seasons and episodes,
**only when the viewer's Overseerr account may create issues**: permission bits `ADMIN` (2),
`MANAGE_ISSUES` (1048576) or `CREATE_ISSUES` (4194304), read from `/api/v1/auth/me`, refreshed at most
every 10 minutes (or from Settings → Overseerr → "Signed in as …").

Flow (all glass sheets):

1. **Reason**: Poor video quality · Wrong audio language · Audio out of sync · Stutters or looks
   corrupt · Wrong film / Wrong episode · Subtitles missing · Subtitles burned in · Something else…
   (asks for a few words with the TV keyboard).
2. **Which episodes** (TV only): just this episode / all of the season / the whole show; from a show
   or season page, a season then an episode.
3. **Confirm**: "Send report · S1 E6 · as <Overseerr user>". If the title already has an open issue
   for the same episodes, the row says when it was reported.
4. `POST /api/v1/issue {issueType, message, mediaId, problemSeason, problemEpisode}`. `mediaId` is
   Overseerr's own media id, found with the title's TMDB id (`lookup` service method). Shows that only
   carry a TVDB id in Plex are found through Overseerr's search.

Issue types: video quality and corrupt → 1 (video); audio language and sync → 2 (audio); both
subtitle reasons → 3; wrong item and other → 4. The two subtitle reasons have their own ids,
`reason=subs-missing` and `reason=subs-burned` (they replace `reason=subtitles`), so the home server
helper can ask Bazarr for missing subtitles instead of replacing the file; burned-in subtitles are
replaced like the other reasons. The message starts with the reason in words (what notifications show)
and ends with one machine-readable line for server-side automation:

```
Wrong audio language

Reported from Plex Lite (S1 E6).
plexlite: reason=audio-language; scope=episode; season=1; episode=6; plex=<ratingKey>; file=<file name>
```

What happens next is up to the server: Overseerr sends its usual "issue reported" notifications, and the
[home server helper](HELPER.md) can act on its webhook: blocklist the release, delete the file, search
again and resolve the issue (or ask Bazarr for missing subtitles), with dry run and safety limits.

## Downloading

- **Downloading screen** (the Overseerr page → Downloads, or OK on a Downloading card): one row per
  title with poster, title, episodes, a progress rail, "45% · 12 min left" and size. Shows group their
  episodes ("S1 E4–E6 · 3 episodes"). It refreshes every 10 s while it's open and stops when hidden.
  It opens at once with the list the shelf already loaded, then refreshes. OK opens the title in Plex
  when it's already in the library.
- **Downloading shelf** on each library's Recommended view (movies in movie libraries, shows in TV
  libraries), only when something is downloading; cards carry the progress bar and a percentage badge.
- **Details badge**: "Downloading 45%", "Almost ready", "Queued" or "Download stalled" on the meta line
  of a movie, show or episode that is in progress.

Source, in order:

1. **The [home server helper](HELPER.md)**, when its address is set: the shared setting (`PL.homeHelper.url()`,
   Settings → Plugins → Home server helper) or, until that exists, the Overseerr page's "Download
   queue address": `GET <address>/queue` (read-only, CORS `*`), one row per Sonarr/Radarr queue record:
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

**A session that ended elsewhere.** Overseerr answers the same 403 ("You do not have permission to
access this endpoint") to a cookie whose session has gone (signed out in Overseerr's own pages,
pruned) and to a user who lacks a permission. On any 403 that isn't about CSRF, the service (like
`seerr-web.js`) asks `/api/v1/auth/me` with the same cookie: if that is refused too, the session has
ended, so it is dropped and the call answers `unauthenticated` (the app then signs the profile in
again, once); otherwise the 403 goes back to the caller as before.

| method | params | answer |
|---|---|---|
| `login` | `url, plexToken, key` | `{user: {id, displayName, permissions}, url}` |
| `status` | `key` | `{signedIn, user?, url}` (never signs in) |
| `request` | `key, method, path, body` | `{status, data}` for `/api/v1<path>` on the signed-in server |
| `downloads` | `key` | `{items: [{mediaId, mediaType, tmdbId, tvdbId, ratingKey, title, year, posterPath, backdropPath, status, downloads: [{title, status, size, sizeLeft, timeLeft, eta, season, episode, episodeTitle}]}], at}` |
| `lookup` | `key, mediaType, tmdbId` | `{title, year, posterPath, media: {mediaId, status, ratingKey, tvdbId, downloads, issues: [open issues]} \| null, seasons?}`; shows add `seasons: [{season, name, episodes, airDate, status, requested: 'pending'\|'approved'\|null}]` (no Specials) |
| `requests` | `key, take` (≤ 50) | `{items: [{id, status, createdAt, updatedAt, mediaType, tmdbId, tvdbId, ratingKey, mediaStatus, is4k, seasons: [{season, status}], mediaSeasons, downloads, title, year, posterPath, backdropPath}], total, at}`: the session's own user's requests |
| `discover` | `key, list` (`trending-movie`, `trending-tv`, `popular-movie`, `popular-tv`, `upcoming-movie`, `upcoming-tv`) | `{list, items: [{id, mediaType, title, year, date, posterPath, backdropPath, overview, status, ratingKey, requested, downloading}], at}` (20 at most) |
| `logout` | `key` or `all: true` | `{}` |

Tests: `node test/overseerr.test.mjs` (plugin logic, and the service against a fake Overseerr),
`node --test test/overseerr-v2.test.mjs` (the page, Your requests, discover rows, Request seasons,
sessions ended elsewhere, the host hooks; the service against the demo's fake Overseerr,
`tools/demo/seerr.mjs`) and `node --test test/overseerr-web.test.mjs` (the browser path behind a simulated browser: CORS,
preflights, same-site cookies; and the same answers as the service for the same fake Overseerr).

## On the web

In the web build ([WEB.md](WEB.md)) there is no webOS service, so `seerr-web.js` answers the same
methods from the page: `fetch` straight to your Overseerr with `credentials: 'include'`, signing in
with the Plex token (`POST /api/v1/auth/plex`) so that Overseerr sets its session cookie in the
browser. The Plex token goes only to your Overseerr, as on the TV. Requests, the Downloading screen,
shelf and badge, and Report a problem work as on the TV, with the same messages.

A browser only allows that when two things are true, and both are up to whoever runs Overseerr:

1. **Plex Lite is served from the same site as Overseerr**, i.e. a subdomain of the same registrable
   domain: `https://plexlite.example.com` with Overseerr at `https://overseerr.example.com`.
   Overseerr's session cookie is `SameSite=Lax` (`Strict` with CSRF protection on), so the browser
   sends it only to requests from pages on the same site. From any other site (for example the
   public `plexlite.vercel.app`) the sign-in succeeds but the browser never sends the cookie back.
   Third-party cookie settings don't matter here, because a same-site cookie is first-party.
2. **Overseerr's reverse proxy allows that origin with credentials and answers preflights.**
   Overseerr sends no CORS headers and answers `OPTIONS` with 405, so the proxy in front of it must,
   for `/api/`:
   - echo the one allowed origin in `Access-Control-Allow-Origin` (never `*`, which browsers refuse
     with credentials), with `Access-Control-Allow-Credentials: true` and `Vary: Origin`;
   - answer `OPTIONS` itself with 204, `Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`
     and the requested headers (Plex Lite sends `Content-Type: application/json` on changes).
   Requests from other origins should pass through untouched.

To use it: deploy the web build on your own subdomain (on Vercel: fork the repo, import it, add the
domain; see [WEB.md](WEB.md#building-and-deploying)), set up the proxy as below, then in Plex Lite on
that address go to Settings → Overseerr → Set up Overseerr and type Overseerr's https address. Each
Plex Home profile signs in once, as on the TV.

### Nginx (and Nginx Proxy Manager)

In the `server` block for Overseerr (in Nginx Proxy Manager: the proxy host → Advanced → Custom Nginx
Configuration; keep its own `location /` and add this one):

```nginx
location /api/ {
    set $cors "";
    if ($http_origin = "https://plexlite.example.com") { set $cors $http_origin; }

    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin $cors always;
        add_header Access-Control-Allow-Credentials true always;
        add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;
        add_header Access-Control-Allow-Headers $http_access_control_request_headers always;
        add_header Access-Control-Max-Age 600 always;
        add_header Vary Origin always;
        return 204;
    }
    add_header Access-Control-Allow-Origin $cors always;
    add_header Access-Control-Allow-Credentials true always;
    add_header Vary Origin always;

    proxy_pass http://overseerr:5055;   # as in your location / block (NPM: $forward_scheme://$server:$port)
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

An empty `$cors` leaves the header out, so other origins get no CORS (as before). A preflight from
another origin gets a 204 without CORS headers, which the browser treats as refused. Keep `always`:
without it Nginx adds the headers to successful answers only, and the browser then can't read
Overseerr's errors. Any `add_header` in this `location` stops `add_header` lines from the `server`
block (HSTS, for example) applying to `/api/`; repeat them here if you have some.

### Cloudflare Worker

If Overseerr is behind Cloudflare, a Worker on the route `overseerr.example.com/api/*` does the same
without touching the server:

```js
const ALLOWED = new Set(['https://plexlite.example.com']);

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin');
    if (!origin || !ALLOWED.has(origin)) return fetch(request);
    // Overseerr answers preflights with 405, so the edge answers them
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        Vary: 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || 'Content-Type',
        'Access-Control-Max-Age': '600' } });
    }
    const upstream = await fetch(request);
    const response = new Response(upstream.body, upstream);
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Credentials', 'true');
    response.headers.append('Vary', 'Origin');
    return response;
  },
};
```

### Overseerr's settings

- **CSRF protection must be off** (Seerr: Settings → Network → "Enable CSRF Protection"; Overseerr:
  Settings → General). It is off by default. When it is on, Overseerr requires a token from its
  `XSRF-TOKEN` cookie on every sign-in and change; that cookie belongs to Overseerr's own host, so a
  page on another host (even on the same site) can't read it, and Overseerr answers 403 "invalid csrf
  token". Reading lists still works, but signing in, requesting and reporting don't. Plex Lite says
  so instead of "this account can't sign in".
- **Cookies.** With CSRF protection off the session cookie is `connect.sid`, `HttpOnly`,
  `SameSite=Lax`, 30 days, and `Secure` when Overseerr sees https (behind a proxy only with
  "Enable Proxy Support" on, so that it trusts `X-Forwarded-Proto`; without it the cookie lacks
  `Secure`, which still works). The proxy must pass `Set-Cookie` on unchanged: no `Domain` rewriting
  is needed (the cookie stays on Overseerr's host; same-site is what counts).
- "Enable Plex Sign-In" (or new Plex users being allowed) works as on the TV: a profile Overseerr
  doesn't know becomes a new Overseerr user on its first, explicit sign-in.

### What Plex Lite shows when something is missing

When a sign-in fails, Plex Lite works out why with a few requests to Overseerr's public
`/api/v1/status` and shows it in a sheet (also listed at the top of Settings → Overseerr until a
call works), with a link to this section:

| Cause | How it's detected | Shown as |
|---|---|---|
| No CORS for this site | the request fails, a `no-cors` request reaches the server | "Overseerr doesn't allow this site" |
| CORS without credentials (or `*`) | works without credentials, fails with them | "Overseerr needs one more setting" (Allow-Credentials) |
| CORS on successful answers only | `/status` works, an error answer (`/auth/me` without the cookie) can't be read | "Overseerr needs one more setting" (`always`) |
| No preflight answer | a simple GET works, the preflighted POST fails | "Overseerr needs one more setting" (OPTIONS) |
| Not the same site | sign-in works but `/auth/me` is refused | "This browser didn't keep the sign-in", naming both sites |
| CSRF protection on | 403 "invalid csrf token" | "Overseerr's CSRF protection is on" |
| Unreachable | every request fails | "Could not reach Overseerr at …" |

### Sessions in a browser

A browser holds one Overseerr cookie per Overseerr address, not one per Plex Home profile, and
Overseerr keeps one session per cookie, so whoever signed in last in that browser is who every call
is made as: Plex Lite in any tab, and Overseerr's own pages too. Plex Lite remembers which profile
the session belongs to; switching profile signs the new profile in again (only one that has signed
in on this browser before, as on the TV). Before every change (a request, a report) Plex Lite waits
until no sign-in is under way in any of its tabs and checks with `/api/v1/auth/me`, just before
sending, that the session is still the profile's Overseerr user; if not, it signs in again first. A
session ended elsewhere (signed out in Overseerr's pages) is noticed the same way and signed in again.

It works both ways: switching profile in Plex Lite also changes who an Overseerr tab open in the same
browser is signed in as (for example from the owner's account to a child's), and signing in to
Overseerr's own pages changes who Plex Lite is until its next check. On a shared computer, sign out
in both. Plex Lite's Sign out (Settings) signs the browser out of Overseerr too.
