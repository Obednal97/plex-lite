// Sonarr v4 / Radarr v5–6 lookups shared by the report flow and the read endpoints (/api/v3).

// History event types as numbers: Sonarr's and Radarr's paged /history take `eventType` as int[].
export const EVENT = { grabbed: 1, downloadFolderImported: 3 };

export const isEvent = (rec, name) => rec && (rec.eventType === name || rec.eventType === EVENT[name]);

// absolute public image URLs only (the arrs' own /MediaCover paths need the API key)
export function images(list) {
  const pick = (type) => {
    const i = (list || []).find((x) => x && x.coverType === type && x.remoteUrl);
    return i ? i.remoteUrl : null;
  };
  return { posterUrl: pick('poster'), fanartUrl: pick('fanart') };
}

export async function seriesByTvdb(sonarr, tvdbId) {
  const list = await sonarr.get('/series', { tvdbId });
  const matches = (Array.isArray(list) ? list : []).filter((s) => Number(s.tvdbId) === Number(tvdbId));
  return matches.length === 1 ? matches[0] : matches.length ? { ambiguous: matches.length } : null;
}

export async function movieByTmdb(radarr, tmdbId) {
  const list = await radarr.get('/movie', { tmdbId });
  const matches = (Array.isArray(list) ? list : []).filter((m) => Number(m.tmdbId) === Number(tmdbId));
  return matches.length === 1 ? matches[0] : matches.length ? { ambiguous: matches.length } : null;
}

export async function episodes(sonarr, seriesId, seasonNumber) {
  const list = await sonarr.get('/episode', { seriesId, seasonNumber });
  return Array.isArray(list) ? list : [];
}

// every queue record (pages of 200)
export async function queue(arr, include) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const r = await arr.get('/queue', { page, pageSize: 200, ...include });
    const recs = (r && r.records) || [];
    out.push(...recs);
    if (!r || out.length >= (r.totalRecords || 0) || !recs.length) break;
  }
  return out;
}

export async function rootFolders(arr) {
  const list = await arr.get('/rootfolder');
  return (Array.isArray(list) ? list : []).map((f) => String(f.path || '')).filter(Boolean);
}

export function underRoot(path, roots) {
  const p = String(path || '');
  return roots.some((r) => {
    const root = r.endsWith('/') || r.endsWith('\\') ? r : `${r}${r.includes('\\') && !r.includes('/') ? '\\' : '/'}`;
    return p.startsWith(root);
  });
}

export const basename = (p) => String(p || '').split(/[\\/]/).pop();

// "[d.]hh:mm:ss" → seconds, or null
export function timeleftSeconds(s) {
  const m = /^(?:(\d+)\.)?(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(String(s || '').trim());
  if (!m) return null;
  return ((Number(m[1] || 0) * 24 + Number(m[2])) * 60 + Number(m[3])) * 60 + Number(m[4]);
}
