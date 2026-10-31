#!/usr/bin/env node
// Plex Lite home helper: makes "Report a problem" fix files (Seerr webhook → Sonarr/Radarr or
// Bazarr), serves the full download queue, What's coming and Bazarr subtitles to Plex Lite.
// Node 18+, no dependencies. Configuration: the environment (systemd EnvironmentFile), or
//   node helper.mjs --env /etc/plexlite-helper/helper.env [--backfill-days N]
// --backfill-days N: on this start only, handle open Plex Lite reports from the last N days once.
// (For the systemd service: `echo 14 > /var/lib/plexlite-helper/BACKFILL_DAYS` and restart.)
// See docs/HELPER.md.
import { createHelper } from './lib/app.mjs';
import { loadEnvFile, readConfig } from './lib/config.mjs';

const args = process.argv.slice(2);
const usage = () => { console.error('usage: node helper.mjs [--env <file>] [--backfill-days <1-365>]'); process.exit(2); };
const envAt = args.indexOf('--env');
if (envAt >= 0) {
  if (!args[envAt + 1]) usage();
  loadEnvFile(args[envAt + 1]);
}
let backfillDays;
const bfAt = args.indexOf('--backfill-days');
if (bfAt >= 0) {
  backfillDays = Number(args[bfAt + 1]);
  if (!Number.isInteger(backfillDays) || backfillDays < 1 || backfillDays > 365) usage();
}

const log = (m) => console.log(m); // journald adds the time
let helper;
try {
  helper = createHelper(readConfig(process.env), { log });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

helper.start({ backfillDays }).catch((e) => {
  console.error(`could not start: ${e.message}`);
  process.exit(1);
});

// Stopping never cuts a fix in half: nothing new starts, and a blocklist → delete → search
// already under way runs to its end (each call has its own deadline; systemd waits 120 s).
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: finishing the current report, then stopping`);
    await helper.close();
    await helper.reports.idle();
    log('stopped');
    process.exit(0);
  });
}
