#!/usr/bin/env node
// Plex Lite home helper: makes "Report a problem" fix files (Seerr webhook → Sonarr/Radarr or
// Bazarr), serves the full download queue, What's coming and Bazarr subtitles to Plex Lite.
// Node 18+, no dependencies. Configuration: the environment (systemd EnvironmentFile), or
//   node helper.mjs --env /etc/plexlite-helper/helper.env
// See docs/HELPER.md.
import { createHelper } from './lib/app.mjs';
import { loadEnvFile, readConfig } from './lib/config.mjs';

const args = process.argv.slice(2);
const envAt = args.indexOf('--env');
if (envAt >= 0) {
  if (!args[envAt + 1]) {
    console.error('usage: node helper.mjs [--env <file>]');
    process.exit(2);
  }
  loadEnvFile(args[envAt + 1]);
}

const log = (m) => console.log(m); // journald adds the time
let helper;
try {
  helper = createHelper(readConfig(process.env), { log });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

helper.start().catch((e) => {
  console.error(`could not start: ${e.message}`);
  process.exit(1);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    log(`${sig}: finishing the current report, then stopping`);
    const timer = setTimeout(() => process.exit(0), 20000);
    timer.unref();
    await helper.close();
    await helper.reports.idle();
    process.exit(0);
  });
}
