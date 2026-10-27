// Local settings for the dev tools, so nothing about one person's TV or server lives in the repo.
// Precedence: environment variables, then tools/local.env (git-ignored), then
// ~/.config/plexlite/config.env (shared by every checkout), then the defaults below.
// See tools/local.env.example for every setting.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export const DEFAULTS = {
  PLEXLITE_TV_SSH: 'lgtv', // ssh destination for the TV: a Host alias in ~/.ssh/config, or root@<tv-ip>
  PLEX_ENV_FILE: '~/.config/plexlite/plex.env', // PLEX_TOKEN=… and PLEX_CLIENT_ID=… for dev builds/server
  TVDEBUG_PORT: '19998', // local end of the DevTools tunnel to the TV's web runtime (:9998)
};

export const expandHome = (p) => (p && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

export function parseEnvFile(file) {
  const out = {};
  if (!file || !existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const merged = {
  ...DEFAULTS,
  ...parseEnvFile(join(configHome, 'plexlite/config.env')),
  ...parseEnvFile(join(HERE, 'local.env')),
};
for (const k of Object.keys(process.env)) if (/^(PLEXLITE_|PLEX_|TVDEBUG_)/.test(k)) merged[k] = process.env[k];

export const config = merged;

// The Plex token and client id for dev tooling: PLEX_TOKEN / PLEX_CLIENT_ID from the environment or
// the config files, else read from PLEX_ENV_FILE. Never commit either value.
export function plexCredentials() {
  const file = parseEnvFile(expandHome(config.PLEX_ENV_FILE));
  const token = config.PLEX_TOKEN || file.PLEX_TOKEN;
  const clientId = config.PLEX_CLIENT_ID || file.PLEX_CLIENT_ID;
  if (!token || !clientId) {
    throw new Error(`no Plex credentials: set PLEX_TOKEN and PLEX_CLIENT_ID, or put them in ${config.PLEX_ENV_FILE} ` +
      '(see tools/local.env.example)');
  }
  return { token, clientId };
}
