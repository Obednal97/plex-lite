// A small JSON HTTP client on node:http/https (no fetch: Node 18 prints an experimental warning
// for it) and the helpers the server uses to answer.
import http from 'node:http';
import https from 'node:https';

export class UpstreamError extends Error {
  constructor(service, status, message, data) {
    super(`${service}: ${message}`);
    this.service = service;
    this.status = status; // 0 = no answer (network, timeout)
    this.data = data;
  }
}

function qs(query) {
  if (!query) return '';
  const parts = [];
  for (const [k, v] of Object.entries(query)) {
    if (v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(one))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// request(service, base, path, opts) → {status, data, headers}. Throws UpstreamError on network
// errors and, unless opts.allow includes the status, on non-2xx answers.
export function request(service, base, path, opts = {}) {
  const { method = 'GET', query, headers = {}, body, form, timeout = 15000, allow = [] } = opts;
  const u = new URL(base + path + qs(query));
  const lib = u.protocol === 'https:' ? https : http;
  const h = { Accept: 'application/json', ...headers };
  let payload = null;
  if (form) {
    payload = Buffer.from(qs(form).slice(1));
    h['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (body !== undefined) {
    payload = Buffer.from(JSON.stringify(body));
    h['Content-Type'] = 'application/json';
  }
  if (payload) h['Content-Length'] = payload.length;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = text;
        if (text && /json/i.test(res.headers['content-type'] || '')) {
          try { data = JSON.parse(text); } catch { /* keep text */ }
        } else if (text && /^[[{]/.test(text.trim())) {
          try { data = JSON.parse(text); } catch { /* keep text */ }
        }
        const status = res.statusCode;
        if ((status >= 200 && status < 300) || allow.includes(status)) resolve({ status, data, headers: res.headers });
        else {
          const msg = (data && typeof data === 'object' && (data.message || data.error)) || (typeof data === 'string' && data.slice(0, 200)) || '';
          reject(new UpstreamError(service, status, `${method} ${u.pathname} → ${status}${msg ? ` (${msg})` : ''}`, data));
        }
      });
      res.on('error', (e) => reject(new UpstreamError(service, 0, `${method} ${u.pathname}: ${e.message}`)));
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`timed out after ${timeout} ms`)));
    req.on('error', (e) => reject(new UpstreamError(service, 0, `${method} ${u.pathname}: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// ---- answering -----------------------------------------------------------------------------------

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Plex-Token',
};

export function send(res, status, data, extra = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, {
    ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extra,
  });
  res.end(body);
}

export class HttpError extends Error {
  constructor(status, error, message) {
    super(message || error);
    this.status = status;
    this.error = error;
  }
}

export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'bad_request', 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new HttpError(400, 'bad_request', 'body is not a JSON object');
  }
}
