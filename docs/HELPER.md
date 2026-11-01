# Home server helper

`helper/` is a small service for the server that runs your media stack. It does what Plex Lite on a
TV or in a browser can't do safely itself, because it needs the Sonarr, Radarr and Bazarr API keys:

- **Report a problem fixes the file.** A report from Plex Lite becomes an Overseerr/Seerr issue; Seerr's
  webhook tells the helper, which blocklists the bad release, deletes the file, searches for a new
  copy, comments on the issue and resolves it. Missing subtitles go to Bazarr instead.
- **Downloading shows the whole queue**, from Sonarr and Radarr, including things nobody requested
  in Overseerr.
- **What's coming** (new episodes this week, films arriving soon, missing episodes) and
  **Subtitles (Bazarr)** in Plex Lite read from it.

It is one Node.js program with no dependencies (Node 18 or newer: Debian 12's own `nodejs` package
is enough), a systemd unit and a settings file. It talks to Seerr, Sonarr (v4), Radarr (v5/v6),
Bazarr (1.4 to 1.6) and your Plex server. It never talks to the download client.

> **It deletes files.** Sonarr's and Radarr's recycle bin is usually off, so a delete is permanent.
> The helper starts in **dry run** (`DRY_RUN=1`): it looks everything up and writes on the Seerr issue
> what it *would* do, and changes nothing. Leave it there until those comments look right.

## How a report is handled

```
Plex Lite ──POST /api/v1/issue──► Seerr ──webhook "Issue reported"──► helper
                                                                       │ GET /api/v1/issue/{id}  (the source of truth)
                                                                       │ Sonarr/Radarr: find → history → mark failed → delete → search
                                                                       │   (or Bazarr: search the missing languages)
                                                                       └ comment on the issue, resolve it
```

The webhook is only a trigger: the helper re-reads the issue from Seerr and acts only when it is
**open**, **untouched** (just the reporter's comment), **recent** (15 minutes; see Backfill) and
**not handled before**. A report that has waited longer than that (the helper was busy or down) gets
a comment saying so. Plex Lite's report message ends with a machine-readable line:

```
plexlite: reason=audio-language; scope=episode; season=1; episode=6; plex=<ratingKey>; file=<file name>
```

| reason | what the helper does |
|---|---|
| `video-quality`, `audio-language`, `out-of-sync`, `corrupt`, `wrong-item` | blocklist + delete + search |
| `subs-burned`, and `subtitles` (older Plex Lite) | blocklist + delete + search (a new copy without burned-in subtitles) |
| `subs-missing` | Bazarr searches the languages it lists as missing; nothing is deleted. Plex is asked to refresh the item. Resolved when something was found, left open with a comment when not |
| `other` ("Something else") | comments "A person will look at this" and leaves it open (`OTHER_ACTION=regrab` re-grabs instead) |

Issues made in Seerr's own pages have no `plexlite:` line: video → `video-quality`, audio →
`audio-language`, subtitles → `subs-missing` (Bazarr; nothing is deleted on a vague report), other →
`other`.

Scope: a **film** (its file), an **episode** (that episode's file; a multi-episode file is searched
for every episode in it), a **season** (every file in the season, grouped by download, so a season
pack is blocklisted once; then a season search). A **whole show** is never automatic: the comment asks
for a season or an episode.

A season is acted on only when **Plex's season is Sonarr's season**: the helper reads the show's
episodes from Plex (with `PLEX_TOKEN`) and requires the same number of episodes in that season and
every file Sonarr would delete to be in it. Aired vs DVD order, absolute numbering or specials filed
into a season would otherwise delete the wrong episodes. Without `PLEX_TOKEN`, season reports wait
for a person. A season can still be up to `MAX_FILES_PER_ISSUE` (25) permanent deletes from one
report; lower it if that's too many for your household.

Per file the helper finds the **newest** import in Sonarr's or Radarr's history
(`downloadFolderImported` whose path ends with the file) and uses it only if it was written when the
file was added (within 10 minutes of the file's `dateAdded`): after a re-grab with the same file
name the older imports are ignored, and a file imported by hand, which has no import of its own, is
never deleted. Then it takes the `grabbed` records of that import's `downloadId`; every one must be
for this film (or this show, and one of the file's episodes), since that history lookup isn't
filtered by title. It marks that grab failed (`POST /history/failed/{id}`, which also blocklists the
release).

**Files with no download history.** Files that Sonarr/Radarr found on disk (a rescan, an old
library) have no import and no grab record, so there is nothing to blocklist. With
`NO_HISTORY_ACTION=redownload` (the default) such a file is deleted and searched again **without** a
blocklist, but only for a **film or a single episode** whose report names **exactly** that file
(`file=`), with every other check passing. The comment says so: "Fixed automatically: this file had
no download history, so nothing could be blocklisted. Deleted `<file>` and searched for a new copy;
the same release may come back." "No history" means none at all for that film or those episodes: an
import that points to another file, or a grab without an import, is history that doesn't match, and
that still waits for a person. Seasons with no history always wait. `NO_HISTORY_ACTION=manual` makes
these wait too. Then it deletes the
file, turns monitoring back on (in case "Unmonitor deleted episodes/movies" is on), and searches. The
order matters: with a quality profile whose cutoff is already met (upgrades off), a search while the
old file is still there grabs nothing. The torrent itself is left alone (it keeps seeding).

The comment on success: "Fixed automatically: blocklisted `<release>`, deleted the file and searched
for a new copy. It shows in Plex Lite → Downloading. If the new one is wrong too, report it again."

## Safety limits

The helper **never deletes** when:

- the history is ambiguous: no import record (a manual import), no download id, imports from
  several downloads, or (Radarr) zero or several grab records. In a season, one ambiguous file stops
  the whole issue;
- the file Plex played (`file=` in the report) isn't Sonarr's/Radarr's file (another version);
- more than `MAX_FILES_PER_ISSUE` (25) files are in scope;
- the title already has something in the Sonarr/Radarr queue (a replacement is coming);
- the file isn't under one of the instance's root folders;
- any earlier step failed. If the blocklist worked but the delete failed, it doesn't search;
- it's a season whose Plex episodes don't match Sonarr's (above);
- it's an older report picked up by a backfill that doesn't name the file Plex played (`file=`);
- the file has no download history and it's a season, the report doesn't name the file, or
  `NO_HISTORY_ACTION=manual` (above).

And it leaves the issue for a person (with a comment saying why) when:

- the reporter's Seerr account doesn't have Create issues, Manage issues or Admin (re-checked when the
  report arrives), or is listed in `DENY_USERS`;
- a limit is reached: **3** automatic fixes per person per 24 h, **10** in total per 24 h, **2** per
  title (film, or show + season) per 7 days;
- it's the second "wrong film / wrong episode" report for the same item within 7 days (usually a
  numbering or mapping problem in Sonarr);
- the report's season and episode don't match the issue's.

A second "wrong audio language" report on a title is fixed but the comment warns that the next copy
may be in that language too.

Other rules:

- **Dry run** (`DRY_RUN=1`, the default): every comment starts "Dry run (nothing changed):", nothing is
  resolved, and the re-grab limits aren't counted. Only exactly `0`, `false`, `no` or `off` turns it
  off; anything else, such as `DRY_RUN=0 # live` (systemd keeps the comment as part of the value),
  keeps the dry run and the start-up log says so. So: **no comments after a value** in the settings
  file. An issue handled in a dry run is handled again, once, when the helper runs live and a
  backfill picks it up (its dry-run comment doesn't count as someone touching the issue).
- **Kill switch:** `PAUSED=1`, or create the file `/var/lib/plexlite-helper/PAUSED`: webhooks are
  acknowledged and only logged, and a report already being looked at stops before its first change
  (it isn't recorded, so a later backfill can still handle it). A `PAUSED` value that isn't
  understood counts as paused.
- **Once only:** issues are handled one at a time, and the issue id is recorded in
  `/var/lib/plexlite-helper/state.json` before the first comment or change, so a restart never
  handles an issue twice. The limits live in the same file, written with fsync and an atomic rename.
- **Interrupted fixes aren't forgotten.** Each step (blocklisting, deleting, searching) is recorded
  before it starts. Stopping the service lets a fix already under way finish (systemd waits up to
  120 s) and starts nothing new. After a crash or a kill, the next start comments on the issue how far
  it got ("interrupted after blocklisting `…`: check Sonarr…") and leaves it open.
- **A damaged state file** is moved aside (`state.json.corrupt-<time>`) and the helper starts with an
  empty state **in dry run**, and stays in dry run while that file is in the folder: restore it as
  `state.json`, or delete it once you've checked the open issues, then restart.
- **Subtitle runs are capped:** a "subtitles missing" report stops starting searches after
  `SUBTITLE_RUN_MAX_SECONDS` (180) and lists what it didn't search, so later reports don't wait.
- **Logs** (journald) name the issue, user id, title, scope, the decision and each failing call;
  never API keys, tokens or the webhook secret.
- **Comments carry no error details** (viewers read them): they say "see the helper's log".
- **LAN only.** Don't publish the helper through a reverse proxy or a tunnel. The webhook needs the
  secret (compared in constant time); actions need a Plex token your server accepts (at most
  `AUTH_FAILS_PER_IP_10_MIN` refused tokens per address and `TOKEN_CHECKS_PER_10_MIN` new tokens in
  all every 10 minutes, so nobody can make it hammer Plex); reads return nothing secret (no download
  ids, paths, indexers or clients). Every upstream call has a total deadline.

### Backfill (a one-off)

Webhook reports are only acted on in their first 15 minutes. Reports made before the helper existed,
or while it was down or in dry run, are handled by a **backfill**: open issues from the last N days
with a `plexlite:` line that the helper hasn't handled, each once. It is off on normal starts
(`BACKFILL_DAYS=0`); run one on purpose:

```sh
echo 14 > /var/lib/plexlite-helper/BACKFILL_DAYS && systemctl restart plexlite-helper   # used once, then deleted
# or by hand: node helper/helper.mjs --env ./helper.env --backfill-days 14
```

A backfilled film or episode is changed only if its report names the file Plex played (`file=`) and
that is still Sonarr's/Radarr's file; a season needs the Plex check above. Others get a comment.
If Seerr isn't answering yet, the backfill is retried every 5 minutes.

## Install (Debian 12, e.g. an unprivileged Proxmox LXC)

A container with 1 CPU, 256 MB of memory and 2 GB of disk is plenty. Give it a fixed LAN address. In
Proxmox, keep the default **nesting** feature on (the systemd unit sandboxes the service; without
nesting it fails with `status=226/NAMESPACE`).

```sh
apt-get update && apt-get install -y git nodejs
git clone https://github.com/Obednal97/plex-lite /opt/plex-lite
sh /opt/plex-lite/helper/install.sh
```

`install.sh` creates `/etc/plexlite-helper/helper.env` once (mode 0600, `DRY_RUN=1`, a random
`WEBHOOK_SECRET`), installs and starts `plexlite-helper.service` (a dynamic user, read-only system,
state in `/var/lib/plexlite-helper`). Then edit the settings file:

| setting | where to find it |
|---|---|
| `SEERR_URL`, `SEERR_API_KEY` | Seerr/Overseerr → Settings → General → API Key |
| `SONARR_URL`, `SONARR_API_KEY`, `RADARR_URL`, `RADARR_API_KEY` | each one's Settings → General → Security → API Key |
| `BAZARR_URL`, `BAZARR_API_KEY` (optional) | Bazarr → Settings → General → Security → API Key |
| `PLEX_URL` | your Plex server's LAN address (`http://…:32400`). Needed for every action: the helper checks the viewer's Plex token against it |
| `PLEX_TOKEN` | the server owner's token: needed to act on season reports (the Plex check above) and to refresh an item after a new subtitle |

Use LAN addresses (`http://…`), not public ones. One setting per line and **no comments after a
value**. See `helper/helper.env.example` for the limits and other settings. Then `systemctl restart plexlite-helper` and check:

```sh
curl -s http://127.0.0.1:8787/healthz     # {"ok":true,…,"dryRun":true,"services":{"seerr":true,…}}
journalctl -u plexlite-helper -f          # what it does, report by report
```

Update: `cd /opt/plex-lite && git pull && sh helper/install.sh` (the settings file is kept).

Run it by hand (any OS with Node 18+): `node helper/helper.mjs --env ./helper.env`, with
`STATE_DIR=./state` in that file.

### Seerr's webhook

Seerr/Overseerr → Settings → Notifications → **Webhook**:

- Enable it. Webhook URL: `http://<helper address>:8787/seerr-webhook`.
- **Authorization header:** `Bearer <WEBHOOK_SECRET>` (the value from the settings file:
  `sed -n 's/^WEBHOOK_SECRET=//p' /etc/plexlite-helper/helper.env`).
- Notification types: **Issue Reported** only. Leave "Support variables in URL" off.
- JSON payload:

```json
{
  "notification_type": "{{notification_type}}",
  "event": "{{event}}",
  "subject": "{{subject}}",
  "message": "{{message}}",
  "issue_id": "{{issue_id}}",
  "issue_type": "{{issue_type}}",
  "issue_status": "{{issue_status}}",
  "reportedBy_username": "{{reportedBy_username}}",
  "media_type": "{{media_type}}",
  "media_tmdbid": "{{media_tmdbid}}",
  "media_tvdbid": "{{media_tvdbid}}",
  "media_status": "{{media_status}}",
  "media_plexRatingKey": "{{media_plexRatingKey}}",
  "{{extra}}": []
}
```

The helper only uses `notification_type` and `issue_id`. The **Test** button sends
`TEST_NOTIFICATION`, which the helper logs and ignores.

**Who may report:** Plex Lite shows "Report a problem" to Seerr users with Create issues (or Manage
issues, or Admin). Give it to the users who should be able to report (in Seerr: Users → edit →
Permissions → Report issues), and add it to Settings → Users → Default permissions for new users.

### Then go live

1. Make a report from Plex Lite on something you don't mind losing (or wait for a real one), and read
   the dry-run comment on the Seerr issue and the log. For reports made before the helper was
   running, run a backfill (above) in dry run.
2. Try a season-pack episode too: one blocklist for the whole pack, only that episode's file deleted.
3. Set `DRY_RUN=0` in the settings file, then `echo 14 > /var/lib/plexlite-helper/BACKFILL_DAYS` and
   `systemctl restart plexlite-helper`: the reports the dry run looked at are fixed now. The log's
   first lines must say `dry run off`.

In Plex Lite: Settings → Plugins → **Home server helper**, address `http://<helper address>:8787`.

## API

Base `http://<helper>:8787`, JSON, UTF-8. Every answer has `Access-Control-Allow-Origin: *`;
`OPTIONS` answers 204 (`Allow-Methods: GET, POST, OPTIONS`, `Allow-Headers: Content-Type, X-Plex-Token`).
Lists carry `{version: 1, updatedAt}`. Images are public URLs (from the arrs' `remoteUrl`).

- **Reads** (`GET`) need no auth.
- **Actions** (`POST`, except the webhook) need `X-Plex-Token: <the viewer's token>`, accepted when
  the Plex server at `PLEX_URL` answers `GET /library/sections` with 200 for it (cached 10 minutes by
  its SHA-256; never logged or stored). At most `ACTIONS_PER_10_MIN` (20) actions per token every 10
  minutes. In dry run, actions change nothing and say so (`dryRun: true`).
- **Errors:** `{error, message}` with `unauthenticated` 401, `rate_limited` 429, `not_found` 404,
  `bad_request` 400 (also 405 for a wrong method), `unavailable` 503 (that service isn't configured
  or didn't answer), `upstream` 502 (it answered with an error), `internal` 500.

| endpoint | answer |
|---|---|
| `GET /healthz` | `{ok, version, dryRun, paused, services: {seerr, sonarr, radarr, bazarr, plex}}`, each `true` when configured and answering within the last minute |
| `POST /seerr-webhook` | `Authorization: Bearer <WEBHOOK_SECRET>`. 202 `{ok, queued}` for an issue; 200 `{ok, ignored}` for other events; `{ok, paused}` when paused |
| `GET /queue` | `{items: [{source, id, mediaType: 'movie'\|'tv', tmdbId, tvdbId, imdbId, title, year, season, episode, episodeTitle, releaseTitle, status, trackedState, size, sizeLeft, timeLeftSeconds, eta, quality, protocol, posterUrl, fanartUrl, errorMessage}]}`, one per Sonarr/Radarr queue record, cached 5 s (format: [OVERSEERR.md](OVERSEERR.md#downloading)) |
| `GET /coming?days=7` | the next `days` (1–30) plus the last 2 days of Sonarr's and Radarr's calendars, monitored only, sorted by date: TV `{source: 'sonarr', mediaType: 'tv', tmdbId, tvdbId, imdbId, title, year, season, episode, episodeTitle, airDateUtc, seasonPremiere, seriesPremiere, hasFile, posterUrl, fanartUrl}`; films `{source: 'radarr', mediaType: 'movie', …, releaseDate, releaseType: 'digital'\|'physical'\|'cinema', hasFile, …}` using the digital date, else physical, else cinema, and only when that date is in the window |
| `GET /missing?tvdbId=` | `{monitored, seasons: [{season, monitored, episodes, have, missing: [{episode, title, airDateUtc}]}]}`: `episodes` and `have` count aired episodes; `missing` lists aired, monitored ones without a file. Specials only when that season is monitored. 404 when Sonarr doesn't have the show |
| `POST /missing/search` | body `{tvdbId, season?, episode?}`: searches the missing aired, monitored episodes in scope that aren't already downloading; a season search when every aired episode of a season is missing. `{queued: true, episodes}`, or `{queued: false, episodes: 0}` when nothing is missing |
| `GET /subtitles?type=episode&tvdbId=&season=&episode=` or `?type=movie&tmdbId=` | from Bazarr: `{languages: [{code, name, forced, hi}], have: [{code, name, forced, hi, external}], missing: [{code, name, forced, hi}]}` (`languages` is the title's language profile) |
| `POST /subtitles/search` | body `{type, tmdbId \| tvdbId+season+episode, language?, forced?, hi?, ratingKey?}`: Bazarr searches and downloads the best match (`language` defaults to the profile's first); the helper waits up to `SUBTITLE_WAIT_SECONDS` (45). `{status: 'downloaded', language, provider, plexRefreshed}` or `{status: 'not_found'}`. Send the Plex `ratingKey` of the movie or episode: the helper refreshes it once Plex confirms it is that title (its guid), and otherwise looks the item up |
| `POST /subtitles/sync` | body as search, `language` required: Bazarr syncs that external subtitle to the audio, in the background (a minute or two). `{status: 'queued'}`; 404 when there's no external subtitle in that language |

## Tests

`node --test test/helper-report.test.mjs test/helper-api.test.mjs test/helper-review.test.mjs test/helper-nohistory.test.mjs` runs the helper against fake
Seerr, Sonarr, Radarr, Bazarr and Plex servers on localhost (`test/helper-fakes.mjs`): every reason
and scope, season packs, each safety limit, backfill across restarts, dry run, auth and rate limits,
`/coming`'s dates, `/missing`, the subtitle search, sync and Plex refresh, and (`helper-review`) the
import/grab matching, files with no download history (`helper-nohistory`), the season check, interrupted fixes, a damaged state file and the auth limits.
