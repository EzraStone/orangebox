// §06 — the proxy engine. Everything here is in the hot path of somebody's
// agent, so the ordering matters: relay first, record afterwards. A recorder
// that slows the thing it records is a recorder people turn off.
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  newId,
  redactHeaders,
  stripBase64,
  serializeForStorage,
  safeStringify
} from './store.mjs';
import * as anthropic from './parse/anthropic.mjs';
import * as openai from './parse/openai.mjs';
import { parseSseFrames, parseFrameJson } from './parse/sse.mjs';

const PARSERS = { anthropic, openai };

/** Bodies are JSON; over this we forward anyway and store a stub (§06.1.2, §14). */
const MAX_REQUEST_BODY = 10 * 1024 * 1024;
const MAX_RESPONSE_CAPTURE = 10 * 1024 * 1024;
const MAX_FORWARD_BODY = 512 * 1024 * 1024;

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
const INTERNAL_HEADERS = new Set([RUN_HEADER, 'x-orangebox-auth', 'x-orangebox-csrf']);

/**
 * §13 — recording happens after the client has its bytes, but "off the hot
 * path" is not the same as "free". Reassembling a 1 MB transcript, serializing
 * it, and writing it are each a contiguous synchronous span, and fifty streams
 * finishing together would stack fifty of them into one ~1 s stall — which
 * shows up as inter-chunk latency on every *other* stream still in flight.
 *
 * So recording is a FIFO of one job at a time that yields to the loop between
 * jobs. Peak event-loop lag becomes one call's work instead of fifty, and
 * better-sqlite3 gets the serialized writer it wants anyway.
 */
function createRecordQueue() {
  let tail = Promise.resolve();
  return {
    push(job) {
      const run = tail.then(async () => {
        try {
          await job();
        } finally {
          await new Promise((resolve) => setImmediate(resolve));
        }
      });
      tail = run.catch(() => {});
      return run;
    }
  };
}

export function createProxy({ store, live, pricing, gapSeconds, providers }) {
  const ctx = { store, live, pricing, gapSeconds, providers, recorder: createRecordQueue() };
  return {
    async handle(req, res, route) {
      try {
        await proxyCall(ctx, req, res, route);
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
  const request = await readBody(req, MAX_REQUEST_BODY);
  const { body: requestBody, captured: capturedRequestBody, overCap } = request;
  const requestJson = tryParseJson(capturedRequestBody);
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
    endpoint: upstreamPath,
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
      redirect: 'manual',
      ...(requestBody && !Buffer.isBuffer(requestBody) ? { duplex: 'half' } : {})
    });
    await request.cleanup();
  } catch (err) {
    await request.cleanup();
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
      requestBody: capturedRequestBody,
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
      req,
      res,
      upstream,
      base,
      requestBody: capturedRequestBody,
      requestJson,
      overCap,
      parser,
      client
    });
  }

  // ---- 4. non-streaming: full body through, unchanged (§06.2)
  return relayNonStream(ctx, {
    res,
    upstream,
    base,
    requestBody: capturedRequestBody,
    requestJson,
    overCap,
    parser,
    client,
    requestHeaders: req.headers
  });
}

async function relayNonStream(ctx, opts) {
  const { res, upstream, base, requestBody, requestJson, overCap, parser, client, requestHeaders } = opts;
  writeHeadFrom(res, upstream, null);
  const captured = [];
  let capturedBytes = 0;
  let responseCaptureTruncated = false;
  let transportError = null;
  const reader = upstream.body?.getReader();

  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const appended = appendCaptured(captured, capturedBytes, value, MAX_RESPONSE_CAPTURE);
        capturedBytes = appended.bytes;
        responseCaptureTruncated ||= appended.truncated;
        if (client.gone) {
          await reader.cancel().catch(() => {});
          break;
        }
        await writeChunk(res, value);
      }
    }
  } catch (err) {
    if (!client.gone) transportError = err;
  }

  const clientAborted = client.gone;
  client.stop();
  if (!res.writableEnded) res.end();
  const raw = Buffer.concat(captured);
  const responseText = raw.toString('utf8');
  await persist(ctx, {
    ...base,
    status: upstream.status,
    error_type: clientAborted
      ? 'client_aborted'
      : transportError
        ? 'upstream_stream_error'
        : upstream.ok
          ? null
          : `http_${upstream.status}`,
    ended_at: Date.now(),
    requestBody,
    requestJson,
    overCap,
    responseCaptureTruncated,
    responseText,
    responseJson: responseCaptureTruncated ? null : tryParseJson(raw),
    requestHeaders,
    parser
  });
}

/**
 * §06.3 — write-through relay. Every chunk goes to the client the instant it
 * arrives; capture is an in-memory append alongside. The only other per-chunk
 * work is first-token detection, and that stops the moment it succeeds.
 */
async function relayStream(ctx, opts) {
  const { req, res, upstream, base, requestBody, requestJson, overCap, parser, client } = opts;
  const { live } = ctx;

  writeHeadFrom(res, upstream, null);

  const chunks = [];
  let capturedBytes = 0;
  let responseCaptureTruncated = false;
  const detector = makeFirstTokenDetector(base.provider);
  let firstTokenAt = null;
  let streamError = null;

  const reader = upstream.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        // Keep undici's chunk as-is. Buffer.from() would copy every chunk —
        // 50 MB of pointless memcpy across fifty 1 MB streams — and undici
        // never hands the same Uint8Array back twice. Buffer.concat takes
        // them directly at the end.
        const appended = appendCaptured(chunks, capturedBytes, value, MAX_RESPONSE_CAPTURE);
        capturedBytes = appended.bytes;
        responseCaptureTruncated ||= appended.truncated;

        if (firstTokenAt === null && detector.sees(value)) {
          firstTokenAt = Date.now();
          live.publish('call.first_token', {
            run_id: base.run_id,
            call_id: base.id,
            ttft_ms: firstTokenAt - base.started_at
          });
        }

        if (client.gone) {
          await reader.cancel().catch(() => {});
          break;
        }
        await writeChunk(res, value);
      }
    } catch (err) {
      // An abort we caused ourselves is the client leaving, not upstream failing.
      if (!client.gone) streamError = err;
    }
  }

  const clientAborted = client.gone;
  client.stop();
  const endedAt = Date.now();
  if (!res.writableEnded) res.end();

  // Reassembly is the expensive part, so it happens inside the queued job
  // rather than here, where it would compete with other live streams.
  await persist(ctx, {
    ...base,
    streamed: 1,
    status: upstream.status,
    error_type: null, // decided during reassembly
    first_token_at: firstTokenAt,
    ended_at: endedAt,
    requestBody,
    requestJson,
    overCap,
    responseChunks: chunks,
    responseCaptureTruncated,
    upstreamOk: upstream.ok,
    upstreamStatus: upstream.status,
    streamOutcome: { clientAborted, streamError },
    requestHeaders: req.headers,
    parser
  });
}

/** §06.3 — fold a captured transcript back into a canonical response object. */
function foldStream(parser, responseText, { clientAborted, streamError }, upstreamOk, upstreamStatus) {
  const { response, error: sseError } = parser.reassembleStream(responseText);

  const errorType = clientAborted
    ? 'client_aborted'
    : streamError || sseError
      ? 'upstream_stream_error'
      : upstreamOk
        ? null
        : `http_${upstreamStatus}`;

  const responseJson = response
    ? {
        ...response,
        _orangebox: {
          reassembled_from_stream: true,
          ...(clientAborted || streamError ? { partial: true } : {}),
          ...(sseError ? { stream_error: sseError } : {}),
          ...(streamError ? { transport_error: String(streamError?.message ?? streamError) } : {})
        }
      }
    : null;

  return { responseJson, errorType };
}

/**
 * §06.3 — "first SSE event that carries content". Scans only until it finds
 * one, then every later chunk costs a single boolean check. Gives up after
 * ~64 KB so a pathological stream cannot turn this into per-chunk parsing.
 */
function makeFirstTokenDetector(provider) {
  const SCAN_LIMIT = 64 * 1024;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let pending = '';
  let done = false;

  return {
    sees(chunk) {
      if (done) return false;
      pending += decoder.decode(chunk, { stream: true });

      for (const frame of parseSseFrames(pending)) {
        if (frame.data === '[DONE]') continue;
        const payload = parseFrameJson(frame.data);

        if (provider === 'anthropic') {
          if ((payload?.type ?? frame.event) === 'content_block_delta') {
            done = true;
            return true;
          }
        } else {
          if (
            payload?.type === 'response.output_text.delta' ||
            payload?.type === 'response.function_call_arguments.delta'
          ) {
            done = true;
            return true;
          }
          const delta = payload?.choices?.[0]?.delta;
          if (delta && typeof delta === 'object' && Object.keys(delta).length > 0) {
            done = true;
            return true;
          }
        }
      }

      if (pending.length > SCAN_LIMIT) {
        done = true; // no content this far in; stop paying for the search
        pending = '';
      }
      return false;
    }
  };
}

// ============================================================== persistence

/** Queue the record; the caller awaits its turn but the client already has its bytes. */
function persist(ctx, input) {
  return ctx.recorder.push(() => writeRecord(ctx, input));
}

/**
 * Build the normalized call record (§7.1) and commit it with its tool events in
 * one transaction (§09). Runs after the client response is finished.
 */
async function writeRecord(ctx, input) {
  const { store, live, pricing } = ctx;
  const { parser, requestJson, requestHeaders, overCap } = input;

  // Streamed calls arrive here as raw chunks so the fold happens on the queue.
  let { responseJson, responseText } = input;
  let errorType = input.error_type ?? null;
  if (input.responseChunks) {
    responseText = Buffer.concat(input.responseChunks).toString('utf8');
    input.responseChunks.length = 0; // release the capture buffers promptly
    const folded = foldStream(
      parser,
      responseText,
      input.streamOutcome,
      input.upstreamOk,
      input.upstreamStatus
    );
    responseJson = folded.responseJson;
    errorType = folded.errorType;
  }

  const extracted = responseJson ? parser.parseResponse(responseJson) : null;

  // Tool payloads are extracted (and cloned) before the blobs are stripped in
  // place below, so the two never fight over the same sub-objects.
  const toolEvents = buildToolEvents({
    store,
    parser,
    runId: input.run_id,
    callId: input.id,
    requestJson,
    responseJson
  });

  const requestBlob = buildRequestBlob({ requestJson, requestHeaders, input });
  const responseBlob = buildResponseBlob({
    responseJson,
    responseText,
    captureTruncated: input.responseCaptureTruncated
  });

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
    error_type: errorType,
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
    truncated:
      request.truncated || response.truncated || overCap || input.responseCaptureTruncated ? 1 : 0
  };

  call.cost_usd = pricing.costFor(call);

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
  // Stripped in place: this object came out of JSON.parse on a buffer we own
  // and nothing else holds a reference, so cloning a multi-megabyte payload
  // just to mutate the copy is pure cost (§13).
  return { ...stripBase64(requestJson), _orangebox: meta };
}

function buildResponseBlob({ responseJson, responseText, captureTruncated = false }) {
  if (captureTruncated) {
    return {
      _orangebox: { capture_truncated: true, captured_bytes: MAX_RESPONSE_CAPTURE },
      body: responseText ?? ''
    };
  }
  if (responseJson !== null && responseJson !== undefined) {
    return stripBase64(responseJson); // ours alone, same reasoning as above
  }
  if (typeof responseText === 'string' && responseText !== '') {
    return { _orangebox: { unparsed: true }, body: responseText };
  }
  return null;
}

/** §7.4 — tool_use from this response, plus any tool_result not yet recorded for the run. */
function buildToolEvents({ store, parser, runId, callId, requestJson, responseJson }) {
  const events = [];

  for (const use of responseJson ? parser.extractToolUses(responseJson) : []) {
    events.push(toolRow(runId, callId, 'tool_use', use));
  }

  const alreadyRecorded = store.recordedToolResultIds(runId);
  for (const result of requestJson ? parser.extractToolResults(requestJson) : []) {
    if (result.tool_use_id && alreadyRecorded.has(result.tool_use_id)) continue;
    if (result.tool_use_id) alreadyRecorded.add(result.tool_use_id);
    events.push(toolRow(runId, callId, 'tool_result', result));
  }

  return events;
}

function toolRow(runId, callId, kind, event) {
  return {
    id: newId(),
    run_id: runId,
    call_id: callId,
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
    if (INTERNAL_HEADERS.has(lower)) continue; // ours, not the provider's
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
  if (!hasBody(req.method)) {
    return { body: undefined, captured: undefined, overCap: false, cleanup: async () => {} };
  }
  const chunks = [];
  let size = 0;
  let overCap = false;
  let tempPath = null;
  let temp = null;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_FORWARD_BODY) {
      await temp?.close().catch(() => {});
      if (tempPath) await fsp.unlink(tempPath).catch(() => {});
      throw new Error(`request body exceeds ${MAX_FORWARD_BODY} bytes`);
    }
    if (!overCap && size <= cap) {
      chunks.push(chunk);
      continue;
    }
    if (!overCap) {
      overCap = true;
      tempPath = path.join(
        os.tmpdir(),
        `orangebox-${process.pid}-${crypto.randomUUID()}.body`
      );
      temp = await fsp.open(tempPath, 'wx');
      for (const buffered of chunks) await temp.writeFile(buffered);
      chunks.length = 0;
    }
    await temp.writeFile(chunk);
  }
  if (temp) {
    await temp.close();
    let cleaned = false;
    return {
      body: fs.createReadStream(tempPath),
      captured: undefined,
      overCap: true,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await fsp.unlink(tempPath).catch(() => {});
      }
    };
  }
  if (chunks.length === 0) {
    return { body: undefined, captured: undefined, overCap: false, cleanup: async () => {} };
  }
  const body = Buffer.concat(chunks);
  return { body, captured: body, overCap: false, cleanup: async () => {} };
}

function appendCaptured(chunks, bytes, chunk, limit) {
  if (bytes >= limit) return { bytes, truncated: true };
  const remaining = limit - bytes;
  if (chunk.length <= remaining) {
    chunks.push(chunk);
    return { bytes: bytes + chunk.length, truncated: false };
  }
  chunks.push(chunk.subarray(0, remaining));
  return { bytes: limit, truncated: true };
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
