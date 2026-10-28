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
| `seerr-web.js` | the web build's browser path: the same methods as the service, with `fetch` from the page (see [On the web](#on-the-web)) |

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

Tests: `node test/overseerr.test.mjs` (plugin logic, and the service against a fake Overseerr) and
`node --test test/overseerr-web.test.mjs` (the browser path behind a simulated browser: CORS,
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

    proxy_pass http://overseerr:5055;   # your Overseerr, as in the location / block
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

An empty `$cors` leaves the header out, so other origins get no CORS (as before). A preflight from
another origin gets a 204 without CORS headers, which the browser treats as refused.

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
  `SameSite=Lax`, 30 days, `Secure` when Overseerr sees https (it trusts the proxy's
  `X-Forwarded-Proto`). The proxy must pass `Set-Cookie` on unchanged: no `Domain` rewriting is needed
  (the cookie stays on Overseerr's host; same-site is what counts).
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
| No preflight answer | a simple GET works, the preflighted POST fails | "Overseerr needs one more setting" (OPTIONS) |
| Not the same site | sign-in works but `/auth/me` is refused | "This browser didn't keep the sign-in", naming both sites |
| CSRF protection on | 403 "invalid csrf token" | "Overseerr's CSRF protection is on" |
| Unreachable | every request fails | "Could not reach Overseerr at …" |

### Sessions in a browser

A browser holds one Overseerr cookie per Overseerr address, not one per Plex Home profile. Plex Lite
remembers which profile it belongs to; switching profile signs the new profile in again (only one
that has signed in on this browser before, as on the TV), which replaces the cookie. Before every
change (a request, a report) Plex Lite checks with `/api/v1/auth/me` that the cookie still belongs to
the profile's Overseerr user, because another tab or Overseerr's own pages in the same browser use
the same cookie: if they don't match it signs in again first. Signing in to Overseerr's own web UI in
that browser therefore also changes who Plex Lite's next request would be made as, until it checks.
Plex Lite's Sign out (Settings) signs the browser out of Overseerr too.
