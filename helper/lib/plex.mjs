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
  // a token whose answer is still cached costs no call to Plex
  function isCached(token) {
    const hit = tokens.get(tokenHash(token));
    return !!hit && now() - hit.at < (hit.ok ? TOKEN_TTL : BAD_TOKEN_TTL);
  }

  async function metadata(key) {
    try {
      const r = await svc.plex.get(`/library/metadata/${encodeURIComponent(key)}`, { includeGuids: 1 });
      return ((r && r.MediaContainer && r.MediaContainer.Metadata) || [])[0] || null;
    } catch { return null; }
  }
  const hasGuid = (m, guid) => !!m && (m.Guid || []).some((g) => String(g.id) === guid);

  // Is this ratingKey (from a viewer, or Seerr) really the target? Checked before using the owner's
  // token on it.
  async function isTarget(key, t) {
    if (!key || !/^\d+$/.test(String(key))) return false;
    const m = await metadata(key);
    if (!m) return false;
    if (t.type === 'movie') return m.type === 'movie' && hasGuid(m, `tmdb://${t.tmdbId}`);
    if (t.type === 'show') return m.type === 'show' && (hasGuid(m, `tvdb://${t.tvdbId}`) || (!!t.tmdbId && hasGuid(m, `tmdb://${t.tmdbId}`)));
    if (m.type !== 'episode' || Number(m.parentIndex) !== Number(t.season) || Number(m.index) !== Number(t.episode)) return false;
    const show = m.grandparentRatingKey ? await metadata(m.grandparentRatingKey) : null;
    return !!show && (hasGuid(show, `tvdb://${t.tvdbId}`) || (!!t.tmdbId && hasGuid(show, `tmdb://${t.tmdbId}`)));
  }

  // the show's ratingKey: the hint when it checks out, else found by its guid
  async function showKey(t, hint) {
    if (hint && (await isTarget(hint, { ...t, type: 'show' }))) return String(hint);
    return findRatingKey({ ...t, type: 'show', season: 0 });
  }

  // [{episode, files: [basename, …]}] for one season of a show, as Plex has it
  async function seasonEpisodes(key, season) {
    const leaves = await svc.plex.get(`/library/metadata/${encodeURIComponent(key)}/allLeaves`);
    return ((leaves && leaves.MediaContainer && leaves.MediaContainer.Metadata) || [])
      .filter((m) => Number(m.parentIndex) === Number(season))
      .map((m) => ({
        episode: Number(m.index),
        files: (m.Media || []).flatMap((md) => (md.Part || []).map((p) => String(p.file || '').split(/[\\/]/).pop())).filter(Boolean),
      }));
  }

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
      // a ratingKey from the viewer is used only when Plex says it is this title
      const key = ratingKey && (await isTarget(ratingKey, t)) ? String(ratingKey) : await findRatingKey(t);
      if (!key) { log(`plex refresh skipped: item not found`); return false; }
      await svc.plex.call('PUT', `/library/metadata/${key}/refresh`);
      return true;
    } catch (e) {
      log(`plex refresh failed: ${e.message}`);
      return false;
    }
  }

  return { checkToken, isCached, refresh, canRefresh, findRatingKey, isTarget, showKey, seasonEpisodes };
}
