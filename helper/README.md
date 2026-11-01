# Plex Lite home helper

A small Node service (Node 18+, no dependencies) for the server that runs Seerr, Sonarr, Radarr and
Bazarr: it makes Plex Lite's **Report a problem** fix the file (blocklist, delete, search again, or ask
Bazarr), and serves the full download queue, What's coming and Bazarr subtitles to Plex Lite.

Everything (what it does, the safety limits, install, Seerr's webhook, the API) is in
[docs/HELPER.md](../docs/HELPER.md).

```sh
git clone https://github.com/Obednal97/plex-lite /opt/plex-lite
sh /opt/plex-lite/helper/install.sh        # Debian 12: creates /etc/plexlite-helper/helper.env (DRY_RUN=1)
```

| file | |
|---|---|
| `helper.mjs` | entry point (`node helper.mjs [--env <file>] [--backfill-days N]`) |
| `lib/app.mjs` | routes, auth, rate limits |
| `lib/report.mjs` | the report flow and its safety rules, backfill |
| `lib/reads.mjs` | `/queue`, `/coming`, `/missing`, `/missing/search` |
| `lib/subtitles.mjs` | Bazarr: `/subtitles`, search, sync |
| `lib/plex.mjs` | viewer token checks, refresh after a subtitle |
| `lib/state.mjs` | `state.json`: handled issues, limits |
| `helper.env.example`, `plexlite-helper.service`, `install.sh` | packaging |

Tests: `node --test test/helper-report.test.mjs test/helper-api.test.mjs test/helper-review.test.mjs test/helper-nohistory.test.mjs`.
