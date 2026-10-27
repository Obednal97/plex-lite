#!/usr/bin/env node
// Desktop test server on http://127.0.0.1:8920. The browser never sees the real Plex token:
// the page gets the placeholder token "dev", and /pms/* is proxied to the Plex server with the
// real token swapped in (and scrubbed from responses). Playwright logs land in the synced project
// folder, so this keeps the token out of them.
//
// Homebrew node can't reach the LAN (macOS Local Network privacy), so the proxy uses the server's
// remote https address from plex.tv.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 8920);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
// random per run, so a page that isn't ours can't guess it
const DEV_TOKEN = `dev-${randomBytes(12).toString('hex')}`;
const SELF = `127.0.0.1:${PORT}`;
// read-only Plex endpoints the UI needs; everything else is refused
const ALLOWED = [/^\/identity$/, /^\/library\//, /^\/hubs/, /^\/photo\//, /^\/livetv\/dvrs$/, /^\/media\/providers$/,
  /^\/tv\.plex\.providers\.epg\.[^/]+\/grid$/, /^\/video\/:\/transcode\/universal\/decision$/];

const env = Object.fromEntries(readFileSync(join(homedir(), '.secrets/plex.env'), 'utf8')
  .split('\n').filter((l) => l.includes('=')).map((l) => l.trim().split(/=(.*)/s).slice(0, 2)));
const TOKEN = env.PLEX_TOKEN;

async function findServer() {
  const r = await fetch(`https://plex.tv/api/v2/resources?includeHttps=1&X-Plex-Token=${TOKEN}&X-Plex-Client-Identifier=${env.PLEX_CLIENT_ID}`,
    { headers: { Accept: 'application/json' } });
  const list = await r.json();
  const s = list.find((x) => (x.provides || '').includes('server') && x.owned) || list[0];
  const conn = s.connections.find((c) => !c.local && !c.relay) || s.connections.find((c) => c.relay);
  return { name: s.name, machineId: s.clientIdentifier, uri: conn.uri, token: s.accessToken || TOKEN };
}

const server = await findServer();
console.log(`proxying /pms -> ${server.name} (remote)`);

const scrub = (s) => s.split(server.token).join(DEV_TOKEN).split(TOKEN).join(DEV_TOKEN);

async function proxy(req, res, path, search) {
  if (req.method !== 'GET' || !ALLOWED.some((re) => re.test(path))) {
    res.writeHead(403);
    return res.end('not allowed by the dev proxy');
  }
  const q = new URLSearchParams(search);
  if (q.get('X-Plex-Token') === DEV_TOKEN) q.set('X-Plex-Token', server.token);
  const target = `${server.uri}${path}${q.toString() ? '?' + q : ''}`;
  try {
    const up = await fetch(target, { method: req.method, headers: { Accept: req.headers.accept || '*/*' } });
    const type = up.headers.get('content-type') || 'application/octet-stream';
    const headers = { 'Content-Type': type };
    if (/json|xml|text|mpegurl/.test(type)) {
      res.writeHead(up.status, headers);
      res.end(scrub(await up.text()));
    } else {
      res.writeHead(up.status, headers);
      res.end(Buffer.from(await up.arrayBuffer()));
    }
  } catch (e) {
    res.writeHead(502);
    res.end(`proxy error: ${scrub(String(e.message))}`);
  }
}

createServer(async (req, res) => {
  // DNS-rebinding and cross-site requests: only our own host/origin may talk to this server
  const origin = req.headers.origin;
  if (req.headers.host !== SELF || (origin && origin !== `http://${SELF}`)) {
    res.writeHead(403);
    return res.end();
  }
  const url = new URL(req.url, 'http://x');
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (path === '/js/dev-config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    return res.end(`window.PL_DEV = ${JSON.stringify({
      token: DEV_TOKEN, clientId: env.PLEX_CLIENT_ID,
      server: { name: server.name + ' (dev proxy)', machineId: server.machineId, uri: `http://127.0.0.1:${PORT}/pms`, token: DEV_TOKEN, kind: 'remote' },
    })};\n`);
  }
  if (path.startsWith('/pms/')) return proxy(req, res, url.pathname.slice(4), url.search);
  const file = normalize(join(APP, path === '/' ? 'index.html' : path));
  if (!file.startsWith(APP)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Plex Lite dev server on http://127.0.0.1:${PORT}`));
