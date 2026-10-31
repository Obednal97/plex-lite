// One small client per upstream service, with the API key in a header (never in a URL, so it
// can't end up in a log line), and a "last answered" time per service for /healthz.
import { request, UpstreamError } from './http.mjs';

const HEADERS = {
  seerr: (c) => ({ 'X-Api-Key': c.key }),
  sonarr: (c) => ({ 'X-Api-Key': c.key }),
  radarr: (c) => ({ 'X-Api-Key': c.key }),
  bazarr: (c) => ({ 'X-API-KEY': c.key }),
  plex: (c) => (c.token ? { 'X-Plex-Token': c.token } : {}),
};
const PREFIX = { seerr: '/api/v1', sonarr: '/api/v3', radarr: '/api/v3', bazarr: '/api', plex: '' };
// cheap authenticated (where possible) calls that prove the service and its key work
const PROBE = { seerr: '/auth/me', sonarr: '/system/status', radarr: '/system/status', bazarr: '/system/status', plex: '/identity' };

export function makeServices(cfg, now = () => Date.now()) {
  const lastOk = {};
  const out = { lastOk };
  for (const name of Object.keys(HEADERS)) {
    const c = cfg[name];
    if (!c) { out[name] = null; continue; }
    const base = c.url + PREFIX[name];
    const call = async (method, path, opts = {}) => {
      const r = await request(name, base, path, {
        timeout: cfg.timeoutMs,
        ...opts,
        method,
        headers: { ...HEADERS[name](c), ...(name === 'plex' ? { 'X-Plex-Product': 'Plex Lite helper' } : {}), ...(opts.headers || {}) },
      });
      lastOk[name] = now();
      return r;
    };
    out[name] = {
      name,
      url: c.url,
      call,
      get: async (path, query, opts) => (await call('GET', path, { ...opts, query })).data,
      post: async (path, body, opts) => (await call('POST', path, { ...opts, body })).data,
      put: async (path, body, opts) => (await call('PUT', path, { ...opts, body })).data,
      del: async (path, opts) => (await call('DELETE', path, opts)).data,
      probe: async () => {
        try { await call('GET', PROBE[name], { timeout: Math.min(cfg.timeoutMs, 4000) }); return true; } catch { return false; }
      },
    };
  }
  // {seerr: bool, …}: configured and answered within the last minute (probing the stale ones)
  out.health = async () => {
    const result = {};
    await Promise.all(Object.keys(HEADERS).map(async (name) => {
      if (!out[name]) { result[name] = false; return; }
      if (lastOk[name] && now() - lastOk[name] < 60000) { result[name] = true; return; }
      result[name] = await out[name].probe();
    }));
    return result;
  };
  return out;
}

export { UpstreamError };
