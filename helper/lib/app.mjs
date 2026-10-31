// The helper: routes, auth and rate limits, wired to the report flow and the read endpoints.
// Contract: docs/HELPER.md (and the plugin builders' copy of it).
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { describeConfig } from './config.mjs';
import { CORS, HttpError, readJson, send, UpstreamError } from './http.mjs';
import { makePlex, tokenHash } from './plex.mjs';
import { makeReads } from './reads.mjs';
import { makeReports } from './report.mjs';
import { makeServices } from './services.mjs';
import { openState } from './state.mjs';
import { makeSubtitles } from './subtitles.mjs';

export const VERSION = '1.0.0';
const TEN_MIN = 10 * 60 * 1000;
const REPLY = Symbol('reply'); // a route answer with its own status code
const BACKFILL_RETRY_MS = 5 * 60 * 1000;

const sha = (s) => createHash('sha256').update(String(s)).digest();
function sameSecret(given, expected) {
  if (!expected) return false;
  return timingSafeEqual(sha(given), sha(expected));
}

export function createHelper(config, opts = {}) {
  const now = opts.now || (() => Date.now());
  const log = opts.log || ((m) => console.log(m));
  const state = openState(config.stateDir, now, log);
  let cfg = config;
  // an unreadable state file was moved aside: no memory of handled issues, so change nothing
  if (state.corruptFiles().length) {
    if (!cfg.dryRun) log(`!!! ${state.corruptFiles().join(', ')} in ${cfg.stateDir}: running in DRY RUN until it is restored or deleted`);
    cfg = { ...cfg, dryRun: true };
  }
  const svc = makeServices(cfg, now);
  const plex = makePlex(cfg, svc, now, log);
  const isPaused = () => cfg.paused || existsSync(join(cfg.stateDir, 'PAUSED'));
  const subs = makeSubtitles({ cfg, svc, plex, now, log });
  const reads = makeReads({ cfg, svc, now, log });
  const reports = makeReports({ cfg, svc, state, plex, subs, now, log, isPaused });

  // ---- action auth: the viewer's Plex token, checked against the Plex server ----
  const actionTimes = new Map(); // sha256(token) → [times]
  const failsByIp = new Map(); // client address → [times of failed token checks]
  let checks = []; // times of token checks that went to Plex
  const recent = (list) => (list || []).filter((x) => now() - x < TEN_MIN);
  async function authorize(req) {
    if (!cfg.plex) throw new HttpError(503, 'unavailable', 'PLEX_URL is not set on the helper, so it cannot check who is asking');
    const ip = String((req.socket && req.socket.remoteAddress) || '?');
    const fails = recent(failsByIp.get(ip));
    failsByIp.set(ip, fails);
    if (fails.length >= cfg.authFailsPerIp10Min) throw new HttpError(429, 'rate_limited', 'too many refused tokens from this address; try again later');
    const token = req.headers['x-plex-token'];
    if (!token || typeof token !== 'string') throw new HttpError(401, 'unauthenticated', 'X-Plex-Token is required');
    if (!plex.isCached(token)) {
      checks = recent(checks);
      if (checks.length >= cfg.tokenChecksPer10Min) throw new HttpError(429, 'rate_limited', 'too many new tokens to check; try again later');
      checks.push(now());
    }
    const ok = await plex.checkToken(token);
    if (ok === null) throw new HttpError(503, 'unavailable', 'the Plex server did not answer');
    if (!ok) {
      fails.push(now());
      if (failsByIp.size > 1000) failsByIp.delete(failsByIp.keys().next().value);
      throw new HttpError(401, 'unauthenticated', 'the Plex server refused this token');
    }
    const h = tokenHash(token);
    const t = now();
    const list = (actionTimes.get(h) || []).filter((x) => t - x < TEN_MIN);
    if (list.length >= cfg.actionsPer10Min) {
      actionTimes.set(h, list);
      throw new HttpError(429, 'rate_limited', `at most ${cfg.actionsPer10Min} actions every 10 minutes`);
    }
    list.push(t);
    actionTimes.set(h, list);
  }

  // ---- routes ----
  const routes = {
    'GET /healthz': async () => ({
      ok: true, version: VERSION, dryRun: cfg.dryRun, paused: isPaused(), services: await svc.health(),
    }),
    'GET /queue': () => reads.getQueue(),
    'GET /coming': (req, url) => reads.getComing(url.searchParams),
    'GET /missing': (req, url) => reads.getMissing(url.searchParams),
    'GET /subtitles': (req, url) => subs.getSubtitles(url.searchParams),
    'POST /missing/search': async (req) => { await authorize(req); return reads.missingSearch(await readJson(req)); },
    'POST /subtitles/search': async (req) => { await authorize(req); return subs.searchAction(await readJson(req)); },
    'POST /subtitles/sync': async (req) => { await authorize(req); return subs.syncAction(await readJson(req)); },
    'POST /seerr-webhook': (req) => webhook(req),
  };

  async function webhook(req) {
    const auth = String(req.headers.authorization || '');
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!sameSecret(given, cfg.webhookSecret)) throw new HttpError(401, 'unauthenticated', 'unauthenticated');
    const body = await readJson(req);
    const type = String(body.notification_type || '');
    const id = Number(body.issue_id);
    if (type === 'TEST_NOTIFICATION') { log('webhook: Seerr test notification (ignored)'); return { ok: true, ignored: 'test' }; }
    if (type !== 'ISSUE_CREATED' || !Number.isInteger(id) || id <= 0) {
      log(`webhook: ${type || 'unknown'} ignored`);
      return { ok: true, ignored: type || 'unknown' };
    }
    if (isPaused()) { log(`webhook: issue #${id} reported while paused: logged only`); return { ok: true, paused: true }; }
    log(`webhook: issue #${id} reported`);
    reports.enqueue(id, 'webhook');
    return { [REPLY]: true, status: 202, body: { ok: true, queued: true } };
  }

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://helper.invalid'); } catch { return send(res, 400, { error: 'bad_request', message: 'bad URL' }); }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') {
      const extra = { ...CORS, 'Access-Control-Max-Age': '600' };
      if (req.headers['access-control-request-private-network']) extra['Access-Control-Allow-Private-Network'] = 'true';
      res.writeHead(204, { ...extra, Allow: 'GET, POST, OPTIONS' });
      return res.end();
    }
    const route = routes[`${req.method} ${path}`];
    if (!route) {
      const known = Object.keys(routes).some((k) => k.endsWith(` ${path}`));
      return send(res, known ? 405 : 404, known ? { error: 'bad_request', message: `${req.method} not allowed here` } : { error: 'not_found', message: 'no such endpoint' });
    }
    try {
      const out = await route(req, url);
      if (out && out[REPLY]) return send(res, out.status, out.body);
      return send(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) {
        if (!(e.status === 401 && path === '/seerr-webhook')) log(`${req.method} ${path}: ${e.status} ${e.message}`);
        return send(res, e.status, { error: e.error, message: e.message });
      }
      if (e instanceof UpstreamError) {
        log(`${req.method} ${path}: ${e.message}`);
        if (e.status === 0) return send(res, 503, { error: 'unavailable', message: `${e.service} did not answer` });
        return send(res, 502, { error: 'upstream', message: e.message });
      }
      log(`${req.method} ${path}: ${e && e.stack ? e.stack : e}`);
      return send(res, 500, { error: 'internal', message: 'helper error' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.keepAliveTimeout = 5000;

  async function logProfiles() {
    for (const name of ['radarr', 'sonarr']) {
      if (!svc[name]) continue;
      try {
        const list = await svc[name].get('/qualityprofile');
        for (const p of Array.isArray(list) ? list : []) log(`${name} quality profile "${p.name}": upgrades ${p.upgradeAllowed ? 'allowed' : 'off'}, cutoff ${p.cutoff}`);
      } catch (e) { log(`${name}: can't read quality profiles: ${e.message}`); }
    }
  }

  let retryTimer = null;
  // Seerr may start after the helper (a reboot): try the backfill again every 5 minutes until it works
  async function backfillUntilDone(days) {
    retryTimer = null;
    const r = await reports.backfill(days);
    if (r === null) {
      log(`backfill: trying again in ${BACKFILL_RETRY_MS / 60000} minutes`);
      retryTimer = setTimeout(() => backfillUntilDone(days), BACKFILL_RETRY_MS);
    }
    return r;
  }

  return {
    cfg, state, reports, server, svc,
    listen(port = cfg.port, host = cfg.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    // opts.backfillDays: a one-off backfill (helper.mjs --backfill-days N). The service gets the
    // same from a BACKFILL_DAYS file in the state folder, used once and then deleted.
    async start(startOpts = {}) {
      const addr = server.listening ? server.address() : await this.listen();
      log(`Plex Lite helper ${VERSION} listening on ${addr.address}:${addr.port}`);
      for (const line of describeConfig(cfg)) log(line);
      await logProfiles();
      await reports.recoverInterrupted();
      let days = startOpts.backfillDays;
      const trigger = join(cfg.stateDir, 'BACKFILL_DAYS');
      if (existsSync(trigger)) {
        const n = Number.parseInt(readFileSync(trigger, 'utf8'), 10);
        try { unlinkSync(trigger); } catch (e) { log(`can't remove ${trigger}: ${e.message}`); }
        if (Number.isInteger(n) && n > 0 && n <= 365) days = n;
        else log(`${trigger} doesn't hold a number of days (1–365): ignored`);
      }
      if (days || cfg.backfillDays) await backfillUntilDone(days || cfg.backfillDays);
      return addr;
    },
    close() {
      if (retryTimer) clearTimeout(retryTimer);
      reports.stop();
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (server.closeAllConnections) server.closeAllConnections();
      });
    },
  };
}
