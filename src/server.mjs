// §04 — the single HTTP server. One process, one port, four kinds of traffic:
// proxied provider calls, the internal JSON API, the SSE live feed, and the
// static UI. Routing is by path prefix, first match wins.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { openStore, newId, safeStringify } from './store.mjs';
import { createLiveHub } from './live.mjs';
import { loadPricing } from './pricing.mjs';
import { createProxy } from './proxy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, '..', 'ui');
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

export const VERSION = PKG.version;

const PROVIDERS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

/**
 * Build (but do not start) the orangebox server.
 * Returns { server, store, live, listen(), close() }.
 */
export function createServer({ dbPath, gapSeconds = 120, providers = PROVIDERS, authToken = null } = {}) {
  const store = openStore(dbPath);
  const live = createLiveHub();
  const pricing = loadPricing();
  const proxy = createProxy({ store, live, pricing, gapSeconds, providers });
  const security = {
    csrfToken: crypto.randomBytes(24).toString('base64url'),
    authToken,
    allowRemote: false
  };

  const server = http.createServer((req, res) => {
    handle(req, res, { store, live, proxy, security }).catch((err) => {
      // Nothing below should throw, but a 500 beats a hung socket.
      if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) });
      else res.end();
    });
  });

  // Provider streams can be long; don't let Node's default timeouts cut them off.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 72_000;

  return {
    server,
    store,
    live,
    pricing,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        security.allowRemote = !isLoopbackAddress(host);
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        live.close();
        server.close(() => {
          store.close();
          resolve();
        });
      });
    }
  };
}

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);

  if (!ctx.security.allowRemote && !isLoopbackHostHeader(req.headers.host)) {
    return sendJson(res, 403, { error: 'invalid host' });
  }

  const protectedRoute =
    pathname === '/api' || pathname.startsWith('/api/') ||
    pathname.startsWith('/anthropic') || pathname.startsWith('/openai') || pathname.startsWith('/r/');
  if (
    protectedRoute &&
    ctx.security.authToken &&
    req.headers['x-orangebox-auth'] !== ctx.security.authToken &&
    url.searchParams.get('token') !== ctx.security.authToken
  ) {
    return sendJson(res, 401, { error: 'orangebox authentication required' });
  }

  // 1. Run-scoped proxy: /r/:runId/{anthropic,openai}/*
  const scoped = pathname.match(/^\/r\/([^/]+)\/(anthropic|openai)(\/.*)?$/);
  if (scoped) {
    return ctx.proxy.handle(req, res, {
      provider: scoped[2],
      upstreamPath: scoped[3] || '/',
      search: url.search,
      runId: scoped[1]
    });
  }

  // 2. Bare proxy: /{anthropic,openai}/*
  const bare = pathname.match(/^\/(anthropic|openai)(\/.*)?$/);
  if (bare) {
    return ctx.proxy.handle(req, res, {
      provider: bare[1],
      upstreamPath: bare[2] || '/',
      search: url.search,
      runId: null
    });
  }

  // 3. Internal API + live feed
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return handleApi(req, res, ctx, pathname, url);
  }

  // 4. Static UI (and SPA fallback for app routes)
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (await serveStatic(req, res, pathname)) return;
  }

  sendJson(res, 404, {
    error: 'unknown route',
    hint: 'agent traffic goes to /anthropic or /openai; UI is at /'
  });
}

// ================================================================= §10 API

async function handleApi(req, res, ctx, pathname, url) {
  const { store, live, security } = ctx;
  const method = req.method;
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]

  if (!['GET', 'HEAD'].includes(method)) {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { error: 'application/json required' });
    }
    if (req.headers['x-orangebox-csrf'] !== security.csrfToken) {
      return sendJson(res, 403, { error: 'invalid csrf token' });
    }
  }

  // GET /api/health
  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      version: VERSION,
      db: store.path,
      runs: store.countRuns(),
      csrf_token: security.csrfToken,
      authenticated: Boolean(security.authToken)
    });
  }

  // GET /api/live  (SSE)
  if (method === 'GET' && pathname === '/api/live') {
    return live.subscribe(req, res);
  }

  // GET /api/runs?limit&offset
  if (method === 'GET' && pathname === '/api/runs') {
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 500);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    return sendJson(res, 200, store.listRuns({ limit, offset }));
  }

  // POST /api/runs/begin
  if (method === 'POST' && pathname === '/api/runs/begin') {
    const body = await readJsonBody(req);
    const run = store.createRun({ name: body?.name ?? null, source: 'explicit' });
    live.publish('run.created', { run });
    return sendJson(res, 200, { id: run.id, run });
  }

  // POST /api/clear
  if (method === 'POST' && pathname === '/api/clear') {
    store.clearAll();
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/runs/:id/end
  if (method === 'POST' && seg.length === 4 && seg[1] === 'runs' && seg[3] === 'end') {
    const ok = store.endRun(seg[2]);
    if (!store.getRun(seg[2])) return sendJson(res, 404, { error: 'no such run' });
    return sendJson(res, 200, { ok });
  }

  // GET|DELETE /api/runs/:id
  if (seg.length === 3 && seg[1] === 'runs') {
    const id = seg[2];
    if (method === 'GET') {
      const run = store.getRun(id);
      if (!run) return sendJson(res, 404, { error: 'no such run' });
      return sendJson(res, 200, {
        run,
        calls: store.callSummaries(id),
        tools: store.toolEvents(id)
      });
    }
    if (method === 'DELETE') {
      const existed = store.deleteRun(id);
      if (!existed) return sendJson(res, 404, { error: 'no such run' });
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      if (!body || (body.tags !== undefined && !Array.isArray(body.tags))) {
        return sendJson(res, 400, { error: 'name and tags expected' });
      }
      const run = store.updateRun(id, { name: body.name, tags: body.tags });
      if (!run) return sendJson(res, 404, { error: 'no such run' });
      live.publish('run.updated', { run });
      return sendJson(res, 200, { run });
    }
  }

  // GET /api/calls/:id
  if (method === 'GET' && seg.length === 3 && seg[1] === 'calls') {
    const call = store.getCall(seg[2]);
    if (!call) return sendJson(res, 404, { error: 'no such call' });
    return sendJson(res, 200, { call });
  }

  // GET /api/export/:runId
  if (method === 'GET' && seg.length === 3 && seg[1] === 'export') {
    const payload = buildExport(store, seg[2]);
    if (!payload) return sendJson(res, 404, { error: 'no such run' });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="orangebox-run-${seg[2]}.json"`
    });
    return void res.end(safeStringify(payload));
  }

  return sendJson(res, 404, { error: 'unknown api route' });
}

/** §10.6 — a run, whole, with nothing left behind in the database. */
export function buildExport(store, runId) {
  const run = store.getRun(runId);
  if (!run) return null;
  return {
    orangebox_export: 1,
    orangebox_version: VERSION,
    exported_at: Date.now(),
    run,
    calls: store.fullCalls(runId),
    tools: store.toolEvents(runId)
  };
}

// ============================================================== static UI

async function serveStatic(req, res, pathname) {
  const isAppRoute = pathname === '/' || pathname === '/run' || pathname.startsWith('/run/');

  let file = null;
  if (!isAppRoute) {
    const candidate = path.join(UI_DIR, pathname);
    // Never let a crafted path escape ui/.
    const resolved = path.resolve(candidate);
    if (resolved.startsWith(path.resolve(UI_DIR) + path.sep) && isFile(resolved)) {
      file = resolved;
    }
  }
  if (!file) {
    if (!isAppRoute) return false;
    file = path.join(UI_DIR, 'index.html');
    if (!isFile(file)) return false;
  }

  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache'
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ================================================================= helpers

export function sendJson(res, status, body) {
  const text = safeStringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

async function readJsonBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) return null;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // CLI and other non-browser clients authenticate with CSRF.
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function isLoopbackAddress(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isLoopbackHostHeader(value) {
  if (!value) return false;
  try {
    return isLoopbackAddress(new URL(`http://${value}`).hostname);
  } catch {
    return false;
  }
}

export { PROVIDERS, newId };
