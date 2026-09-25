// §22.4 — orangebox served over HTTPS.
//
// The point of these is that nothing except the socket changes. The proxy, the
// API and replay all have to behave identically, and replay in particular has
// to notice it is now talking to itself over a different scheme.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { generateSelfSigned } from '../src/tls/certificate.mjs';
import { startMockUpstream, jsonResponse, settle, removeTempDir } from './helpers.mjs';

/** An orangebox listening over TLS, with a client that verifies its cert. */
async function startSecure({ providers } = {}) {
  const tls = generateSelfSigned({ hosts: ['localhost'], ips: ['127.0.0.1'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-https-'));
  const dbPath = path.join(dir, 'secure.db');

  const app = createServer({ dbPath, providers, tls });
  const address = await app.listen(0, '127.0.0.1');
  const origin = `https://127.0.0.1:${address.port}`;

  const request = (route, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(origin + route);
      const req = https.request(
        {
          hostname: url.hostname, port: url.port, path: url.pathname + url.search,
          method, headers, agent: false,
          ca: tls.cert, servername: '127.0.0.1'
        },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode, body: text }));
        }
      );
      req.on('error', reject);
      req.end(body);
    });

  return { app, origin, tls, request, dbPath, cleanup: () => removeTempDir(dbPath) };
}

test('the API answers over TLS with a verified certificate', async () => {
  const secure = await startSecure();
  try {
    const health = await secure.request('/api/health');
    assert.equal(health.status, 200);
    assert.ok(JSON.parse(health.body).csrf_token);
  } finally {
    await secure.app.close();
    secure.cleanup();
  }
});

test('a proxied call is recorded the same way over TLS', async () => {
  // Nothing under the socket should know the difference.
  const upstream = await startMockUpstream((req, res) =>
    jsonResponse(res, 200, {
      model: 'claude-opus-5', stop_reason: 'end_turn',
      usage: { input_tokens: 120, output_tokens: 8 }
    })
  );
  const secure = await startSecure({ providers: { anthropic: upstream.origin, openai: upstream.origin } });

  try {
    const relayed = await secure.request('/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(relayed.status, 200);

    assert.ok(await settle(secure.app, () => secure.app.store.countRuns() === 1));
    const runId = secure.app.store.listRuns().runs[0].id;
    const call = secure.app.store.callSummaries(runId)[0];

    assert.equal(call.model, 'claude-opus-5');
    assert.equal(call.input_tokens, 120);
  } finally {
    await secure.app.close();
    await upstream.close();
    secure.cleanup();
  }
});

test('replay works over TLS, talking to orangebox through its own certificate', async () => {
  // The bug this catches: replay posts back through orangebox so the call is
  // recorded on the way past. That URL was hard-coded to http, so under --https
  // every replay failed with what looked like an unreachable provider.
  const upstream = await startMockUpstream((req, res) =>
    jsonResponse(res, 200, {
      model: 'claude-opus-5', stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 4 }
    })
  );
  const secure = await startSecure({ providers: { anthropic: upstream.origin, openai: upstream.origin } });

  try {
    await secure.request('/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'first' }] })
    });
    assert.ok(await settle(secure.app, () => secure.app.store.countRuns() === 1));

    const runId = secure.app.store.listRuns().runs[0].id;
    const callId = secure.app.store.callSummaries(runId)[0].id;
    const csrf = JSON.parse((await secure.request('/api/health')).body).csrf_token;

    const replay = await secure.request(`/api/calls/${encodeURIComponent(callId)}/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orangebox-csrf': csrf },
      body: '{}'
    });

    assert.equal(replay.status, 200, `replay failed over TLS: ${replay.body}`);
    const result = JSON.parse(replay.body);
    assert.ok(result.call_id, 'the replayed call was recorded');
    assert.equal(result.status, 200);
  } finally {
    await secure.app.close();
    await upstream.close();
    secure.cleanup();
  }
});

test('without a certificate the server is still plain HTTP', async () => {
  // The default has to stay unchanged: --https is opt-in.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-plain-'));
  const dbPath = path.join(dir, 'plain.db');
  const app = createServer({ dbPath });
  const address = await app.listen(0, '127.0.0.1');

  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(res.status, 200);
  } finally {
    await app.close();
    removeTempDir(dbPath);
  }
});

test('a partial tls option does not half-enable HTTPS', async () => {
  // A cert with no key, or the reverse, must fall back to HTTP rather than
  // throwing at listen time with something opaque.
  const generated = generateSelfSigned({ hosts: ['localhost'], ips: ['127.0.0.1'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-partial-'));
  const dbPath = path.join(dir, 'partial.db');

  const app = createServer({ dbPath, tls: { cert: generated.cert } });
  const address = await app.listen(0, '127.0.0.1');

  try {
    const res = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(res.status, 200, 'fell back to HTTP');
  } finally {
    await app.close();
    removeTempDir(dbPath);
  }
});
