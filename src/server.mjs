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
import { compareRuns, sanitizeExport, buildHtmlReport, buildOtelExport } from './export.mjs';
import { createMobileAccess, mobileSessionCanAccess, MOBILE_SESSION_TTL_SECONDS } from './mobile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, '..', 'ui');
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

export const VERSION = PKG.version;

const PROVIDERS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  // Local by default. Honours OLLAMA_HOST, which is the variable Ollama's own
  // tooling already uses, so a non-default install needs nothing new learned.
  //
  // Worth noting against §12.1: this does not widen the outbound promise. The
  // default target is the loopback interface, and orangebox still only connects
  // in direct response to a request somebody proxied through it.
  ollama: normalizeOllamaHost(process.env.OLLAMA_HOST) ?? 'http://127.0.0.1:11434',
  gemini: 'https://generativelanguage.googleapis.com',
  // Region-specific, so it reads AWS_REGION the way every AWS tool does.
  //
  // §19.3 caveat: SigV4 signs the Host header and orangebox strips Host like
  // any reverse proxy, so a SigV4-signed request cannot survive the hop. Use a
  // Bedrock API key (bearer auth) and it works like the others. orangebox will
  // not hold your AWS credentials in order to re-sign on your behalf.
  bedrock: `https://bedrock-runtime.${process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'}.amazonaws.com`
};

/** OLLAMA_HOST is commonly set bare, as `host:port`, with no scheme. */
function normalizeOllamaHost(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const raw = value.trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

/**
 * Build (but do not start) the orangebox server.
 * Returns { server, store, live, listen(), close() }.
 */
export function createServer({
  dbPath,
  gapSeconds = 120,
  providers = PROVIDERS,
  authToken = null,
  mobileAccess = false,
  maxPendingCapture
} = {}) {
  const store = openStore(dbPath);
  const live = createLiveHub();
  const pricing = loadPricing();
  const proxy = createProxy({ store, live, pricing, gapSeconds, providers, maxPendingCapture });
  const mobile = createMobileAccess({ enabled: mobileAccess });
  const security = {
    csrfToken: crypto.randomBytes(24).toString('base64url'),
    authToken,
    allowRemote: false
  };

  const server = http.createServer((req, res) => {
    handle(req, res, { store, live, proxy, security, mobile }).catch((err) => {
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
    mobile,
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

  // Pairing is the only unauthenticated API surface exposed in mobile mode.
  // The high-entropy code is printed locally and never returned by this route.
  if (pathname === '/api/mobile/status' && req.method === 'GET') {
    if (!ctx.mobile.enabled) return sendJson(res, 404, { error: 'mobile access is disabled' });
    return sendJson(res, 200, { enabled: true, paired: Boolean(mobileToken(req) && ctx.mobile.authenticate(mobileToken(req))) });
  }
  if (pathname === '/api/mobile/pair' && req.method === 'POST') {
    if (!ctx.mobile.enabled) return sendJson(res, 404, { error: 'mobile access is disabled' });
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { error: 'application/json required' });
    }
    const body = await readJsonBody(req, 4_096);
    if (!body) return sendJson(res, 400, { error: 'pairing code expected' });
    const paired = ctx.mobile.pair({ code: body.code, name: body.name, address: req.socket.remoteAddress ?? '' });
    if (!paired.ok) return sendJson(res, paired.status, { error: paired.error });
    return sendJson(res, paired.status, { session: paired.session }, {
      'set-cookie': mobileCookie(paired.token, req.socket.encrypted === true)
    });
  }

  const protectedRoute =
    pathname === '/api' || pathname.startsWith('/api/') ||
    pathname.startsWith('/anthropic') || pathname.startsWith('/openai') || pathname.startsWith('/r/');
  if (protectedRoute) {
    const localBypass = ctx.security.allowRemote && isLoopbackSocket(req.socket.remoteAddress);
    const adminAuthenticated =
      (!ctx.security.authToken && !ctx.mobile.enabled) ||
      (!ctx.security.authToken && !ctx.security.allowRemote) ||
      localBypass ||
      (ctx.security.authToken && (
        req.headers['x-orangebox-auth'] === ctx.security.authToken ||
        url.searchParams.get('token') === ctx.security.authToken
      ));
    const session = !adminAuthenticated ? ctx.mobile.authenticate(mobileToken(req)) : null;

    if (!adminAuthenticated && !session) {
      return sendJson(res, 401, { error: 'orangebox authentication required' });
    }
    if (session) {
      req.orangeboxMobileSession = session;
      if (!mobileSessionCanAccess(req.method, pathname)) {
        const error = pathname.startsWith('/api/')
          ? 'mobile session is read-only'
          : 'mobile sessions cannot proxy provider traffic';
        return sendJson(res, 403, { error });
      }
    }
  }

  // 1. Run-scoped proxy: /r/:runId/{anthropic,openai}/*
  const scoped = pathname.match(/^\/r\/([^/]+)\/(anthropic|openai|ollama|gemini|bedrock)(\/.*)?$/);
  if (scoped) {
    return ctx.proxy.handle(req, res, {
      provider: scoped[2],
      upstreamPath: scoped[3] || '/',
      search: url.search,
      runId: scoped[1]
    });
  }

  // 2. Bare proxy: /{anthropic,openai}/*
  const bare = pathname.match(/^\/(anthropic|openai|ollama|gemini|bedrock)(\/.*)?$/);
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
      authenticated: Boolean(security.authToken),
      platform: process.platform,
      mobile_access: ctx.mobile.enabled,
      mobile_manage: ctx.mobile.enabled && isLoopbackSocket(req.socket.remoteAddress),
      mobile_session: req.orangeboxMobileSession ?? null
    });
  }

  if (method === 'GET' && pathname === '/api/mobile/sessions') {
    if (!isLoopbackSocket(req.socket.remoteAddress)) return sendJson(res, 403, { error: 'local access required' });
    return sendJson(res, 200, { sessions: ctx.mobile.listSessions() });
  }

  if (method === 'POST' && pathname === '/api/mobile/pair/rotate') {
    if (!isLoopbackSocket(req.socket.remoteAddress)) return sendJson(res, 403, { error: 'local access required' });
    return sendJson(res, 200, { code: ctx.mobile.rotatePairingCode() });
  }

  if (method === 'DELETE' && seg.length === 4 && seg[1] === 'mobile' && seg[2] === 'sessions') {
    if (!isLoopbackSocket(req.socket.remoteAddress)) return sendJson(res, 403, { error: 'local access required' });
    const revoked = ctx.mobile.revoke(seg[3]);
    return sendJson(res, revoked ? 200 : 404, revoked ? { ok: true } : { error: 'no such mobile session' });
  }

  // GET /api/live  (SSE)
  if (method === 'GET' && pathname === '/api/live') {
    return live.subscribe(req, res);
  }

  // GET /api/runs?limit&offset
  if (method === 'GET' && pathname === '/api/runs') {
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 500);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    return sendJson(res, 200, store.listRuns({
      limit,
      offset,
      search: url.searchParams.get('search')?.trim() ?? '',
      model: url.searchParams.get('model')?.trim() ?? '',
      provider: url.searchParams.get('provider')?.trim() ?? '',
      tool: url.searchParams.get('tool')?.trim() ?? '',
      error: url.searchParams.get('error') ?? '',
      minLatency: optionalNumber(url.searchParams.get('min_latency')),
      minCost: optionalNumber(url.searchParams.get('min_cost')),
      from: optionalNumber(url.searchParams.get('from')),
      to: optionalNumber(url.searchParams.get('to'))
    }));
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

  // POST /api/calls/:id/replay
  if (method === 'POST' && seg.length === 4 && seg[1] === 'calls' && seg[3] === 'replay') {
    const original = store.getCall(seg[2]);
    if (!original) return sendJson(res, 404, { error: 'no such call' });
    if (original.truncated) {
      return sendJson(res, 409, { error: 'truncated calls cannot be replayed safely' });
    }
    const body = await readJsonBody(req);
    if (!body || (body.request !== undefined && !isPlainObject(body.request))) {
      return sendJson(res, 400, { error: 'request must be a JSON object' });
    }
    const stored = parseJson(original.request_json);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      return sendJson(res, 409, { error: 'the recorded request is not replayable JSON' });
    }
    delete stored._orangebox;
    const replayRequest = body.request === undefined ? stored : body.request;
    if (body.model !== undefined) replayRequest.model = String(body.model);

    const sourceRun = store.getRun(original.run_id);
    const run = store.createRun({
      name: String(body.name || `replay of ${sourceRun?.name || original.run_id}`).slice(0, 200),
      source: 'explicit'
    });
    live.publish('run.created', { run });

    const headers = replayHeaders(original.provider, security.authToken);
    const replayUrl = `http://${req.headers.host}/r/${encodeURIComponent(run.id)}/${original.provider}${original.endpoint}`;
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(replayUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(replayRequest),
        signal: AbortSignal.timeout(10 * 60 * 1000)
      });
      await upstreamResponse.text();
    } catch (error) {
      return sendJson(res, 502, { error: 'replay failed', detail: String(error?.message ?? error), run_id: run.id });
    }

    const replayed = await waitForCall(store, run.id);
    store.endRun(run.id);
    return sendJson(res, replayed ? 200 : 202, {
      run_id: run.id,
      call_id: replayed?.id ?? null,
      status: upstreamResponse.status
    });
  }

  // GET /api/compare?left=:runId&right=:runId
  if (method === 'GET' && pathname === '/api/compare') {
    const comparison = compareRuns(store, url.searchParams.get('left'), url.searchParams.get('right'));
    if (!comparison) return sendJson(res, 404, { error: 'one or both runs do not exist' });
    return sendJson(res, 200, comparison);
  }

  // GET /api/spend?group=model|provider|run|day&since=&until=  (§19.5)
  if (method === 'GET' && pathname === '/api/spend') {
    const group = url.searchParams.get('group') ?? 'model';
    if (!SPEND_GROUPINGS.has(group)) {
      return sendJson(res, 400, {
        error: `unknown group "${group}"`,
        allowed: [...SPEND_GROUPINGS]
      });
    }
    const since = epochParam(url.searchParams.get('since'));
    const until = epochParam(url.searchParams.get('until'));
    return sendJson(res, 200, store.spend({ groupBy: group, since, until }));
  }

  // GET /api/export/:runId
  if (method === 'GET' && seg.length === 3 && seg[1] === 'export') {
    let payload = buildExport(store, seg[2]);
    if (!payload) return sendJson(res, 404, { error: 'no such run' });
    const sanitize = url.searchParams.get('sanitize');
    if (sanitize) payload = sanitizeExport(payload, { full: sanitize === 'full' });
    const format = url.searchParams.get('format') ?? 'json';
    const safeId = seg[2].replace(/[^a-zA-Z0-9_-]/g, '_');
    if (format === 'html') {
      if (!sanitize) payload = sanitizeExport(payload);
      const html = buildHtmlReport(payload);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="orangebox-run-${safeId}.html"`,
        'content-length': Buffer.byteLength(html),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
      });
      return void res.end(html);
    }
    if (format === 'otel') payload = buildOtelExport(payload);
    else if (format !== 'json') return sendJson(res, 400, { error: 'format must be json, html, or otel' });
    const filename = format === 'otel' ? `orangebox-run-${safeId}.otel.json` : `orangebox-run-${safeId}.json`;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`
    });
    return void res.end(safeStringify(payload));
  }

  return sendJson(res, 404, { error: 'unknown api route' });
}

/** Groupings the spend endpoint will accept; the store owns the SQL behind them. */
const SPEND_GROUPINGS = new Set(['model', 'provider', 'run', 'day']);

/**
 * `since`/`until` accept epoch milliseconds or anything Date can parse, so
 * `?since=2026-07-01` works as readily as a timestamp. Junk becomes null,
 * which means "no bound" rather than "everything since 1970".
 */
function epochParam(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
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
  // Client-side routes. Each one has to serve the shell, because a reload or
  // a pasted link arrives here as a plain GET with no history to fall back on.
  const isAppRoute =
    pathname === '/' ||
    pathname === '/run' ||
    pathname === '/spend' ||
    pathname.startsWith('/run/');

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
  const headers = {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache'
  };
  if (path.basename(file) === 'service-worker.js') headers['service-worker-allowed'] = '/';
  res.writeHead(200, headers);
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

export function sendJson(res, status, body, extraHeaders = {}) {
  const text = safeStringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders
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

function optionalNumber(raw) {
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function replayHeaders(provider, authToken) {
  const headers = {
    'content-type': 'application/json',
    ...(authToken ? { 'x-orangebox-auth': authToken } : {})
  };
  if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    headers.authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
  }
  if (provider === 'anthropic') {
    if (process.env.ANTHROPIC_API_KEY) headers['x-api-key'] = process.env.ANTHROPIC_API_KEY;
    headers['anthropic-version'] = process.env.ANTHROPIC_VERSION || '2023-06-01';
  }
  return headers;
}

async function waitForCall(store, runId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const call = store.lastCallOfRun(runId);
    if (call) return call;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

function isLoopbackSocket(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLoopbackHostHeader(value) {
  if (!value) return false;
  try {
    return isLoopbackAddress(new URL(`http://${value}`).hostname);
  } catch {
    return false;
  }
}

function mobileToken(req) {
  const header = req.headers['x-orangebox-mobile'];
  if (typeof header === 'string') return header;
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer obm_')) return authorization.slice(7);
  const cookie = String(req.headers.cookie ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith('orangebox_mobile='));
  if (cookie) return decodeURIComponent(cookie.slice('orangebox_mobile='.length));
  return null;
}

function mobileCookie(token, secure) {
  return [
    `orangebox_mobile=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${MOBILE_SESSION_TTL_SECONDS}`,
    ...(secure ? ['Secure'] : [])
  ].join('; ');
}

export { PROVIDERS, newId };
