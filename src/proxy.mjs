// §06 — the proxy engine. Everything here is in the hot path of somebody's
// agent, so the ordering matters: relay first, record afterwards. A recorder
// that slows the thing it records is a recorder people turn off.
import { Buffer } from 'node:buffer';

import {
  newId,
  redactHeaders,
  stripBase64,
  serializeForStorage,
  safeStringify
} from './store.mjs';
import * as anthropic from './parse/anthropic.mjs';
import * as openai from './parse/openai.mjs';

const PARSERS = { anthropic, openai };

/** Bodies are JSON; over this we forward anyway and store a stub (§06.1.2, §14). */
const MAX_REQUEST_BODY = 10 * 1024 * 1024;

/** No response headers within this window and we give up on upstream (§14.1). */
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

/** Tool payloads get their own, tighter cap — they are previews, not archives. */
const MAX_TOOL_CONTENT = 256 * 1024;

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'te',
  'trailer',
  'expect'
]);

/** Response headers we must not blindly relay when we re-chunk (§06.1.4). */
const STRIP_FROM_RESPONSE = new Set([...HOP_BY_HOP, 'content-encoding']);

const RUN_HEADER = 'x-orangebox-run-id';

export function createProxy({ store, live, pricing, gapSeconds, providers }) {
  return {
    async handle(req, res, route) {
      try {
        await proxyCall({ store, live, pricing, gapSeconds, providers }, req, res, route);
      } catch (err) {
        // A bug in the recorder must never take down the agent's request.
        if (!res.headersSent) {
          sendJson(res, 502, { error: 'orangebox proxy error', detail: String(err?.message ?? err) });
        } else {
          res.end();
        }
      }
    }
  };
}

async function proxyCall(ctx, req, res, route) {
  const { store, live, pricing, gapSeconds, providers } = ctx;
  const { provider, upstreamPath, search, runId: pathRunId } = route;
  const parser = PARSERS[provider];

  // ---- 1. buffer the request body (§06.1.2)
  const { body: requestBody, overCap } = await readBody(req, MAX_REQUEST_BODY);
  const requestJson = tryParseJson(requestBody);
  const requestInfo = parser.parseRequest(requestJson);

  // ---- 2. resolve the run before dispatch, so call.started can name it (§06.4)
  const headerRunId = firstHeader(req.headers[RUN_HEADER]);
  const { run, created } = store.resolveRun({
    explicitRunId: pathRunId,
    headerRunId,
    gapSeconds
  });
  if (created) live.publish('run.created', { run });

  const callId = newId();
  const upstreamUrl = providers[provider] + upstreamPath + (search ?? '');

  // ---- 3. forward (§06.1.3)
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);
  timeout.unref?.();

  // The only trustworthy "client went away" signal. `req.destroyed` is not it:
  // fully consuming the request body auto-destroys the readable, so it reads
  // true on every healthy request.
  const client = watchClient(res, controller);

  const startedAt = Date.now();
  live.publish('call.started', {
    run_id: run.id,
    call_id: callId,
    provider,
    model: requestInfo.model,
    started_at: startedAt,
    streamed: requestInfo.stream ? 1 : 0
  });

  const base = {
    id: callId,
    run_id: run.id,
    provider,
    endpoint: upstreamPath,
    method: req.method,
    model: requestInfo.model,
    started_at: startedAt,
    streamed: requestInfo.stream ? 1 : 0
  };

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req.headers),
      body: requestBody,
      signal: controller.signal,
      redirect: 'manual'
    });
  } catch (err) {
    clearTimeout(timeout);
    client.stop();
    const errorType = timedOut
      ? 'upstream_timeout'
      : client.gone
        ? 'client_aborted'
        : 'upstream_unreachable';
    const status = errorType === 'upstream_timeout' ? 504 : 502;

    if (!res.headersSent && !client.gone) {
      sendJson(res, status, {
        error: errorType,
        detail: String(err?.message ?? err),
        upstream: upstreamUrl
      });
    } else if (!res.writableEnded) {
      res.end();
    }
    await persist(ctx, {
      ...base,
      status: null,
      error_type: errorType,
      ended_at: Date.now(),
      requestBody,
      requestJson,
      overCap,
      responseText: null,
      responseJson: null,
      requestHeaders: req.headers,
      parser
    });
    return;
  }

  clearTimeout(timeout);

  const isStream = requestInfo.stream || /text\/event-stream/i.test(upstream.headers.get('content-type') ?? '');

  if (isStream) {
    return relayStream(ctx, {
      req, res, upstream, base, requestBody, requestJson, overCap, parser, client
    });
  }

  // ---- 4. non-streaming: full body through, unchanged (§06.2)
  const raw = Buffer.from(await upstream.arrayBuffer());
  const endedAt = Date.now();
  client.stop();

  writeHeadFrom(res, upstream, raw.length);
  await endResponse(res, raw);

  const responseText = raw.toString('utf8');
  await persist(ctx, {
    ...base,
    status: upstream.status,
    error_type: upstream.ok ? null : `http_${upstream.status}`,
    ended_at: endedAt,
    requestBody,
    requestJson,
    overCap,
    responseText,
    responseJson: tryParseJson(raw),
    requestHeaders: req.headers,
    parser
  });
}

/**
 * §06.3 — write-through relay. Each chunk reaches the client the moment it
 * arrives; the capture buffer is an in-memory append alongside it. Reassembly
 * of the captured transcript lands in M2.
 */
async function relayStream(ctx, opts) {
  const { req, res, upstream, base, requestBody, requestJson, overCap, parser, client } = opts;
  writeHeadFrom(res, upstream, null);

  const chunks = [];
  let streamError = null;

  const reader = upstream.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        if (client.gone) {
          await reader.cancel().catch(() => {});
          break;
        }
        await writeChunk(res, value);
      }
    } catch (err) {
      streamError = err;
    }
  }

  const clientAborted = client.gone;
  client.stop();
  const endedAt = Date.now();
  if (!res.writableEnded) res.end();

  const responseText = Buffer.concat(chunks).toString('utf8');
  const errorType = clientAborted
    ? 'client_aborted'
    : streamError
      ? 'upstream_stream_error'
      : upstream.ok
        ? null
        : `http_${upstream.status}`;

  await persist(ctx, {
    ...base,
    streamed: 1,
    status: upstream.status,
    error_type: errorType,
    ended_at: endedAt,
    requestBody,
    requestJson,
    overCap,
    responseText,
    responseJson: null, // reassembly arrives in M2
    requestHeaders: req.headers,
    parser
  });
}

// ============================================================== persistence

/**
 * Build the normalized call record (§7.1) and commit it with its tool events in
 * one transaction (§09). Runs after the client response is finished.
 */
async function persist(ctx, input) {
  const { store, live, pricing } = ctx;
  const { parser, requestJson, responseJson, responseText, requestHeaders, overCap } = input;

  const extracted = responseJson ? parser.parseResponse(responseJson) : null;

  const requestBlob = buildRequestBlob({ requestJson, requestHeaders, input });
  const responseBlob = buildResponseBlob({ responseJson, responseText });

  const request = serializeForStorage(requestBlob);
  const response =
    responseBlob === null ? { json: null, truncated: 0 } : serializeForStorage(responseBlob);

  const latency = input.ended_at != null ? input.ended_at - input.started_at : null;
  const ttft = input.first_token_at != null ? input.first_token_at - input.started_at : null;

  const call = {
    id: input.id,
    run_id: input.run_id,
    seq: store.nextSeq(input.run_id),
    provider: input.provider,
    endpoint: input.endpoint,
    // §7.1: prefer the response's model — it names the snapshot actually served.
    model: extracted?.model ?? input.model ?? null,
    status: input.status ?? null,
    error_type: input.error_type ?? null,
    streamed: input.streamed ?? 0,
    started_at: input.started_at,
    first_token_at: input.first_token_at ?? null,
    ended_at: input.ended_at ?? null,
    latency_ms: latency,
    ttft_ms: ttft,
    input_tokens: extracted?.input_tokens ?? null,
    output_tokens: extracted?.output_tokens ?? null,
    cache_read_tokens: extracted?.cache_read_tokens ?? null,
    cache_write_tokens: extracted?.cache_write_tokens ?? null,
    stop_reason: extracted?.stop_reason ?? null,
    cost_usd: null,
    request_json: request.json,
    response_json: response.json,
    truncated: request.truncated || response.truncated || (overCap ? 1 : 0) ? 1 : 0
  };

  call.cost_usd = pricing.costFor(call);

  const toolEvents = buildToolEvents({ store, parser, call, requestJson, responseJson });

  try {
    store.insertCall(call, toolEvents);
  } catch (err) {
    // Losing a record is bad; crashing the process is worse (§07, §14).
    console.error(`orangebox: failed to record call ${call.id}: ${err?.message ?? err}`);
    return;
  }

  live.publish('call.completed', { run_id: call.run_id, call_id: call.id });
}

function buildRequestBlob({ requestJson, requestHeaders, input }) {
  const meta = {
    method: input.method ?? undefined,
    headers: redactHeaders(requestHeaders)
  };
  if (input.overCap) {
    meta.truncated_request = `body exceeded ${MAX_REQUEST_BODY} bytes and was forwarded but not stored`;
    return { _orangebox: meta };
  }
  if (requestJson === null) {
    // Non-JSON or malformed body: keep it verbatim rather than dropping it (§14.2).
    const raw = input.requestBody?.toString('utf8') ?? '';
    return { _orangebox: { ...meta, unparsed: true }, body: raw };
  }
  return { ...stripBase64(structuredClone(requestJson)), _orangebox: meta };
}

function buildResponseBlob({ responseJson, responseText }) {
  if (responseJson !== null && responseJson !== undefined) {
    return stripBase64(structuredClone(responseJson));
  }
  if (typeof responseText === 'string' && responseText !== '') {
    return { _orangebox: { unparsed: true }, body: responseText };
  }
  return null;
}

/** §7.4 — tool_use from this response, plus any tool_result not yet recorded for the run. */
function buildToolEvents({ store, parser, call, requestJson, responseJson }) {
  const events = [];

  for (const use of responseJson ? parser.extractToolUses(responseJson) : []) {
    events.push(toolRow(call, 'tool_use', use));
  }

  const alreadyRecorded = store.recordedToolResultIds(call.run_id);
  for (const result of requestJson ? parser.extractToolResults(requestJson) : []) {
    if (result.tool_use_id && alreadyRecorded.has(result.tool_use_id)) continue;
    if (result.tool_use_id) alreadyRecorded.add(result.tool_use_id);
    events.push(toolRow(call, 'tool_result', result));
  }

  return events;
}

function toolRow(call, kind, event) {
  return {
    id: newId(),
    run_id: call.run_id,
    call_id: call.id,
    kind,
    tool_name: event.tool_name ?? null,
    tool_use_id: event.tool_use_id ?? null,
    is_error: event.is_error ? 1 : 0,
    content_json:
      event.content === null || event.content === undefined
        ? null
        : serializeForStorage(stripBase64(structuredClone(event.content)), MAX_TOOL_CONTENT).json
  };
}

// ================================================================= plumbing

/**
 * Track whether the client hung up before we finished answering, and abort the
 * upstream request when it does (§06.3). `stop()` before a deliberate res.end()
 * so a normal completion is never mistaken for an abort.
 */
function watchClient(res, controller) {
  const state = {
    gone: false,
    stop() {
      res.off('close', onClose);
    }
  };
  function onClose() {
    if (res.writableEnded) return;
    state.gone = true;
    controller.abort();
  }
  res.on('close', onClose);
  return state;
}

function buildUpstreamHeaders(incoming) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower.startsWith('proxy-')) continue;
    if (lower === RUN_HEADER) continue; // ours, not the provider's
    if (value === undefined) continue;
    headers.set(lower, Array.isArray(value) ? value.join(', ') : String(value));
  }
  // Capture plaintext bytes rather than teach the tee about gzip (§06.1.3).
  headers.set('accept-encoding', 'identity');
  return headers;
}

function writeHeadFrom(res, upstream, contentLength) {
  const headers = {};
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (STRIP_FROM_RESPONSE.has(lower)) return;
    headers[lower] = value;
  });
  if (contentLength !== null) headers['content-length'] = contentLength;
  res.writeHead(upstream.status, headers);
  res.flushHeaders?.();
}

/** Respect backpressure — a write-through relay that ignores it is a memory leak. */
function writeChunk(res, chunk) {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => res.once('drain', resolve));
}

function endResponse(res, body) {
  return new Promise((resolve) => {
    if (res.writableEnded) return resolve();
    res.end(body, resolve);
  });
}

async function readBody(req, cap) {
  if (!hasBody(req.method)) return { body: undefined, overCap: false };
  const chunks = [];
  let size = 0;
  let overCap = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) overCap = true;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return { body: undefined, overCap: false };
  return { body: Buffer.concat(chunks), overCap };
}

function hasBody(method) {
  return method !== 'GET' && method !== 'HEAD';
}

function tryParseJson(buffer) {
  if (buffer === undefined || buffer === null) return null;
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function firstHeader(value) {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value !== '' ? value : null;
}

function sendJson(res, status, body) {
  const text = safeStringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}
