// Configuration, read only from the environment (systemd's EnvironmentFile, or `--env <file>`).
// See helper.env.example for every setting. No defaults point at a real server.
import { readFileSync } from 'node:fs';

// KEY=value lines, '#' comments, optional single or double quotes. Values already in the
// environment win, so `DRY_RUN=0 node helper.mjs --env …` works for a one-off.
export function loadEnvFile(path, env = process.env) {
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (!(m[1] in env)) env[m[1]] = value;
  }
  return env;
}

const flag = (v, dflt) => {
  if (v == null || String(v).trim() === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
};
const int = (v, dflt, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};
const url = (v) => {
  const s = String(v || '').trim().replace(/\/+$/, '');
  return s || null;
};

export function readConfig(env = process.env) {
  const svc = (name) => {
    const u = url(env[`${name}_URL`]);
    const key = String(env[`${name}_API_KEY`] || '').trim();
    return u && key ? { url: u, key } : null;
  };
  const plexUrl = url(env.PLEX_URL);
  return {
    port: int(env.PORT, 8787, 1, 65535),
    host: String(env.BIND || env.HOST || '0.0.0.0'),
    stateDir: String(env.STATE_DIR || env.STATE_DIRECTORY || '/var/lib/plexlite-helper').split(':')[0],
    seerr: svc('SEERR'),
    sonarr: svc('SONARR'),
    radarr: svc('RADARR'),
    bazarr: svc('BAZARR'),
    plex: plexUrl ? { url: plexUrl, token: String(env.PLEX_TOKEN || '').trim() || null } : null,
    webhookSecret: String(env.WEBHOOK_SECRET || ''),
    // dry-run is the default: changing anything needs an explicit DRY_RUN=0
    dryRun: flag(env.DRY_RUN, true),
    paused: flag(env.PAUSED, false),
    otherAction: String(env.OTHER_ACTION || 'manual').trim().toLowerCase() === 'regrab' ? 'regrab' : 'manual',
    backfillDays: int(env.BACKFILL_DAYS, 14, 0, 365),
    maxIssueAgeMinutes: int(env.MAX_ISSUE_AGE_MINUTES, 15, 1, 24 * 60),
    maxFilesPerIssue: int(env.MAX_FILES_PER_ISSUE, 25, 1, 500),
    limitPerUser24h: int(env.LIMIT_PER_USER_24H, 3, 0, 1000),
    limitTotal24h: int(env.LIMIT_TOTAL_24H, 10, 0, 10000),
    limitPerTitle7d: int(env.LIMIT_PER_TITLE_7D, 2, 0, 1000),
    denyUsers: String(env.DENY_USERS || '').split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite),
    actionsPer10Min: int(env.ACTIONS_PER_10_MIN, 20, 1, 10000),
    subtitleWaitSeconds: int(env.SUBTITLE_WAIT_SECONDS, 45, 1, 600),
    // upstream request timeout (ms); tests shorten it
    timeoutMs: int(env.UPSTREAM_TIMEOUT_MS, 15000, 100, 120000),
    pollMs: int(env.POLL_MS, 2000, 10, 60000),
  };
}

// What the start-up log says about the configuration: never keys or tokens.
export function describeConfig(c) {
  const on = (s) => (s ? 'configured' : 'not configured');
  return [
    `seerr ${on(c.seerr)}, sonarr ${on(c.sonarr)}, radarr ${on(c.radarr)}, bazarr ${on(c.bazarr)}, ` +
      `plex ${c.plex ? 'configured' + (c.plex.token ? ' (with PLEX_TOKEN)' : ' (no PLEX_TOKEN: no refresh after subtitles)') : 'not configured (actions disabled)'}`,
    `dry run ${c.dryRun ? 'ON (nothing is changed)' : 'off'}, paused ${c.paused ? 'yes' : 'no'}, other=${c.otherAction}, ` +
      `backfill ${c.backfillDays} days, webhook secret ${c.webhookSecret ? 'set' : 'NOT SET (webhook refuses everything)'}`,
    `limits: ${c.limitPerUser24h}/user/24h, ${c.limitTotal24h}/24h, ${c.limitPerTitle7d}/title/7d, ` +
      `${c.maxFilesPerIssue} files/issue, issues younger than ${c.maxIssueAgeMinutes} min, ${c.actionsPer10Min} actions/token/10 min`,
  ];
}
