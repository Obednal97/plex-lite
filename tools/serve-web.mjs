#!/usr/bin/env node
// Serves the web build (dist/web, from tools/build-web.mjs) on http://127.0.0.1:8940 with the
// headers from vercel.json, so the Content-Security-Policy and the rest can be tried locally.
//
//   node tools/serve-web.mjs [dir]       PORT=8941 to change the port
//
// http://127.0.0.1 counts as a secure origin in browsers, so the app behaves as on https; Chrome's
// local-network prompt only appears on a public origin (the Vercel deployment).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const ROOT = normalize(process.argv[2] ? join(process.cwd(), process.argv[2]) : join(APP, 'dist/web'));
const PORT = Number(process.env.PORT || 8940);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
const rules = JSON.parse(readFileSync(join(APP, 'vercel.json'), 'utf8')).headers
  .map((r) => ({ re: new RegExp(`^${r.source}$`), headers: r.headers }));

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  const headers = {};
  for (const r of rules) if (r.re.test(path)) for (const h of r.headers) headers[h.key] = h.value;
  delete headers['Strict-Transport-Security']; // not on plain http
  // upgrade-insecure-requests would turn this server's own http URLs into https ones
  if (headers['Content-Security-Policy']) headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace(/;\s*upgrade-insecure-requests/, '');
  const file = normalize(join(ROOT, path.endsWith('/') ? path + 'index.html' : path));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, headers);
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Plex Lite web build on http://127.0.0.1:${PORT} (${ROOT})`));
