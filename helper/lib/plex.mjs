// Plex: checking a viewer's token (for actions), and refreshing an item after a subtitle arrives
// so the new sidecar file shows up (needs PLEX_TOKEN).
import { createHash } from 'node:crypto';
import { request } from './http.mjs';

const TOKEN_TTL = 10 * 60 * 1000;
const BAD_TOKEN_TTL = 60 * 1000;
const GUID_TTL = 10 * 60 * 1000;

export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

export function makePlex(cfg, svc, now = () => Date.now(), log = () => {}) {
  const tokens = new Map(); // sha256(token) → {ok, at}
  let guidCache = null; // {at, movie: Map(guid → ratingKey), show: Map}

  // true when the Plex server answers GET /library/sections with 200 for this token
  async function checkToken(token) {
    if (!cfg.plex || !token) return false;
    const h = tokenHash(token);
    const hit = tokens.get(h);
    if (hit && now() - hit.at < (hit.ok ? TOKEN_TTL : BAD_TOKEN_TTL)) return hit.ok;
    let ok = false;
    try {
      const r = await request('plex', cfg.plex.url, '/library/sections', {
        headers: { 'X-Plex-Token': token, 'X-Plex-Product': 'Plex Lite helper' },
        timeout: Math.min(cfg.timeoutMs, 8000),
        allow: [401, 403],
      });
      ok = r.status === 200;
      if (ok) svc.lastOk.plex = now();
    } catch (e) {
      // Plex unreachable: don't cache, so the next try asks again
      log(`plex token check failed: ${e.message}`);
      return null;
    }
    tokens.set(h, { ok, at: now() });
    if (tokens.size > 500) tokens.delete(tokens.keys().next().value);
    return ok;
  }

  const canRefresh = () => !!(svc.plex && cfg.plex && cfg.plex.token);

  async function guids() {
    if (guidCache && now() - guidCache.at < GUID_TTL) return guidCache;
    const out = { at: now(), movie: new Map(), show: new Map() };
    const sections = await svc.plex.get('/library/sections');
    for (const d of (sections && sections.MediaContainer && sections.MediaContainer.Directory) || []) {
      if (d.type !== 'movie' && d.type !== 'show') continue;
      const all = await svc.plex.get(`/library/sections/${encodeURIComponent(d.key)}/all`, { includeGuids: 1 });
      for (const m of (all && all.MediaContainer && all.MediaContainer.Metadata) || []) {
        for (const g of m.Guid || []) out[d.type].set(String(g.id), String(m.ratingKey));
      }
    }
    guidCache = out;
    return out;
  }

  // the ratingKey of a movie (tmdbId) or an episode (tvdbId + season + episode), or null
  async function findRatingKey(t) {
    const g = await guids();
    if (t.type === 'movie') return g.movie.get(`tmdb://${t.tmdbId}`) || null;
    const showKey = g.show.get(`tvdb://${t.tvdbId}`) || (t.tmdbId ? g.show.get(`tmdb://${t.tmdbId}`) : null);
    if (!showKey) return null;
    if (t.type === 'show' || !t.season) return showKey;
    const leaves = await svc.plex.get(`/library/metadata/${encodeURIComponent(showKey)}/allLeaves`);
    const ep = ((leaves && leaves.MediaContainer && leaves.MediaContainer.Metadata) || [])
      .find((m) => Number(m.parentIndex) === Number(t.season) && Number(m.index) === Number(t.episode));
    return ep ? String(ep.ratingKey) : null;
  }

  // Ask Plex to refresh one item. Returns true when asked, false when skipped (no PLEX_TOKEN,
  // item not found). Never throws: a failed refresh only delays the subtitle showing.
  async function refresh(t, ratingKey) {
    if (!canRefresh()) return false;
    try {
      const key = ratingKey && /^\d+$/.test(String(ratingKey)) ? String(ratingKey) : await findRatingKey(t);
      if (!key) { log(`plex refresh skipped: item not found`); return false; }
      await svc.plex.call('PUT', `/library/metadata/${key}/refresh`);
      return true;
    } catch (e) {
      log(`plex refresh failed: ${e.message}`);
      return false;
    }
  }

  return { checkToken, refresh, canRefresh, findRatingKey };
}
