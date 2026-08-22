// Shared scaffolding for the test suite. No network access anywhere: every
// "upstream" is a node:http server on 127.0.0.1 (§17.1 check 10).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server.mjs';

/** A stand-in provider. `handler(req, res, body)` decides what upstream does. */
export async function startMockUpstream(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests: seen,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** An orangebox instance on an ephemeral port with a throwaway database. */
export async function startOrangebox({
  providers,
  gapSeconds = 120,
  authToken = null,
  mobileAccess = false,
  maxPendingCapture
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-test-'));
  const dbPath = path.join(dir, 'test.db');
  const app = createServer({ dbPath, gapSeconds, providers, authToken, mobileAccess, maxPendingCapture });
  const address = await app.listen(0, '127.0.0.1');

  return {
    ...app,
    dbPath,
    origin: `http://127.0.0.1:${address.port}`,
    async stop() {
      await app.close();
      await removeTempDir(dir);
    }
  };
}

/**
 * Windows keeps SQLite's -wal and -shm handles open a moment longer than
 * close() returns, so an immediate delete throws EBUSY/EPERM — and `force`
 * only swallows ENOENT, not that. Retry briefly, then give up quietly: this is
 * teardown, and a leaked temp directory must never fail a passing test.
 */
export async function removeTempDir(dir) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      await sleep(50);
    }
  }
  return false;
}

export function jsonResponse(res, status, body, extraHeaders = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders
  });
  res.end(text);
}

/** Write an SSE transcript out one frame at a time, with a beat between them. */
export async function sseResponse(res, frames, { delayMs = 2 } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  for (const frame of frames) {
    res.write(frame);
    if (delayMs) await sleep(delayMs);
  }
  res.end();
}

/** Write an NDJSON transcript one line at a time, the way Ollama streams. */
export async function ndjsonResponse(res, lines, { delayMs = 2 } = {}) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  for (const line of lines) {
    res.write(line + String.fromCharCode(10));
    if (delayMs) await sleep(delayMs);
  }
  res.end();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getJson(url, init) {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

/** The recorder writes after the client response completes; give it a beat. */
export async function settle(app, predicate, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(10);
  }
}

export const ANTHROPIC_MESSAGE = {
  id: 'msg_01Test',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5-20251001',
  content: [{ type: 'text', text: 'ping' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 12,
    output_tokens: 5,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 40
  }
};

export const OPENAI_COMPLETION = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4o-mini-2024-07-18',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'ping' }, finish_reason: 'stop' }
  ],
  usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 }
};

/**
 * Write AWS event-stream frames, the way Bedrock's ConverseStream does.
 * Frames are written as raw buffers — the point of the exercise is that these
 * bytes are not text and must not be handled as text anywhere along the way.
 */
export async function eventStreamResponse(res, frames, { delayMs = 2 } = {}) {
  res.writeHead(200, {
    'content-type': 'application/vnd.amazon.eventstream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  for (const frame of frames) {
    res.write(frame);
    if (delayMs) await sleep(delayMs);
  }
  res.end();
}
