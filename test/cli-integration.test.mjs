// The CLI as a person meets it: a real subprocess, real flags, real banner.
//
// The in-process tests build a server by calling createServer() with a
// providers map already assembled. That skips the code turning flags into
// configuration, which is exactly where three providers were silently broken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli, startCliServer, removeTempDir, startMockUpstream, jsonResponse } from './helpers.mjs';

test('--version and --help answer without touching a database', async () => {
  const version = await runCli(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  for (const command of ['run', 'export', 'assert', 'spend', 'clear']) {
    assert.match(help.stdout, new RegExp(`orangebox ${command}`), `help omits ${command}`);
  }
});

test('an unknown command exits non-zero and prints usage', async () => {
  const result = await runCli(['definitely-not-a-command']);
  assert.equal(result.code, 1);
  assert.match(result.output, /unknown command/);
  assert.match(result.output, /USAGE/);
});

test('a bad flag value is refused rather than half-applied', async () => {
  const result = await runCli(['--openai-upstream', 'not-a-url', '--no-open']);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /--openai-upstream needs an http\(s\) URL/);
});

test('the banner names the database and the UI url', async () => {
  const server = await startCliServer();
  try {
    assert.match(server.output, /orangebox v\d+\.\d+\.\d+/);
    assert.match(server.output, /recording on/);
    assert.match(server.output, /database/);
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await server.stop();
    removeTempDir(server.dbPath);
  }
});

test('every advertised provider routes to a real upstream from the CLI (§19.3)', async () => {
  // The regression this file exists for. Each provider is pointed at a mock,
  // so a route that resolved to "undefined/..." fails here loudly instead of
  // shipping. Anything that reaches the mock has been configured correctly.
  const upstream = await startMockUpstream((req, res) =>
    jsonResponse(res, 200, { ok: true, saw: req.url })
  );
  const server = await startCliServer([
    '--openai-upstream', upstream.origin,
    '--anthropic-upstream', upstream.origin,
    '--gemini-upstream', upstream.origin,
    '--ollama-upstream', upstream.origin,
    '--bedrock-upstream', upstream.origin
  ]);

  const routes = {
    anthropic: '/anthropic/v1/messages',
    openai: '/openai/v1/chat/completions',
    gemini: '/gemini/v1beta/models/gemini-3.1-pro:generateContent',
    ollama: '/ollama/api/chat',
    bedrock: '/bedrock/model/test-model/converse'
  };

  try {
    for (const [provider, route] of Object.entries(routes)) {
      const res = await fetch(`${server.origin}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [] })
      });
      const body = await res.json();

      assert.equal(res.status, 200, `${provider} did not reach its upstream: ${JSON.stringify(body)}`);
      assert.equal(body.ok, true, `${provider} got an unexpected body`);
      assert.doesNotMatch(
        JSON.stringify(body),
        /undefined/,
        `${provider} proxied to an undefined upstream`
      );
    }
  } finally {
    await server.stop();
    await upstream.close();
    removeTempDir(server.dbPath);
  }
});

test('run-scoped routes work from the CLI for every provider too', async () => {
  // /r/<run-id>/<provider>/... is what `orangebox run` points agents at, so it
  // has to accept exactly the same provider set as the bare route.
  const upstream = await startMockUpstream((req, res) => jsonResponse(res, 200, { ok: true }));
  const server = await startCliServer([
    '--openai-upstream', upstream.origin,
    '--anthropic-upstream', upstream.origin,
    '--gemini-upstream', upstream.origin,
    '--ollama-upstream', upstream.origin,
    '--bedrock-upstream', upstream.origin
  ]);

  try {
    for (const provider of ['anthropic', 'openai', 'gemini', 'ollama', 'bedrock']) {
      const res = await fetch(`${server.origin}/r/scoped-run/${provider}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [] })
      });
      assert.equal(res.status, 200, `scoped route rejected ${provider}`);
    }
  } finally {
    await server.stop();
    await upstream.close();
    removeTempDir(server.dbPath);
  }
});

test('a provider with no flag still resolves its default upstream', async () => {
  // The test above passes every --*-upstream flag, which quietly masks the bug
  // it was written for: the flags populate the map whether or not the defaults
  // are spread in. This one passes no provider flag at all and reaches ollama
  // through OLLAMA_HOST, so it exercises the default-construction path — the
  // one that resolved to "undefined/api/chat" for a whole release.
  const upstream = await startMockUpstream((req, res) => jsonResponse(res, 200, { ok: true }));
  const server = await startCliServer([], { env: { OLLAMA_HOST: upstream.origin } });

  try {
    const res = await fetch(`${server.origin}/ollama/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2', messages: [] })
    });
    const body = await res.json();
    assert.equal(res.status, 200, `ollama did not resolve a default upstream: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
  } finally {
    await server.stop();
    await upstream.close();
    removeTempDir(server.dbPath);
  }
});
