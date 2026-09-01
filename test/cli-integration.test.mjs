// The CLI as a person meets it: a real subprocess, real flags, real banner.
//
// The in-process tests build a server by calling createServer() with a
// providers map already assembled. That skips the code turning flags into
// configuration, which is exactly where three providers were silently broken.
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
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
    assert.ok(await server.waitForOutput(/database/), `banner never named the database:\n${server.output}`);
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

/** Record one call through a CLI-started server and return its ids. */
async function recordOneCall(server, { model = 'claude-opus-5' } = {}) {
  const res = await fetch(`${server.origin}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-orangebox-run-id': 'cli-test-run' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })
  });
  await res.text();

  for (let i = 0; i < 100; i++) {
    const runs = await (await fetch(`${server.origin}/api/runs`)).json();
    const run = runs.runs.find((r) => r.id === 'cli-test-run');
    if (run?.call_count > 0) return run;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the call was never recorded');
}

test('`spend` reads a database written by a different process', async () => {
  // The CLI subcommands open the same SQLite file the server is writing. WAL
  // mode is what makes that safe, and nothing tested it across two processes.
  const upstream = await startMockUpstream((req, res) =>
    jsonResponse(res, 200, {
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 200 }
    })
  );
  const server = await startCliServer(['--anthropic-upstream', upstream.origin]);

  try {
    await recordOneCall(server);

    const table = await runCli(['spend', '--db', server.dbPath]);
    assert.equal(table.code, 0, table.output);
    assert.match(table.stdout, /spend by model/);
    assert.match(table.stdout, /claude-opus-5/);
    assert.match(table.stdout, /total \$/);

    const json = await runCli(['spend', '--db', server.dbPath, '--json']);
    assert.equal(json.code, 0);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.total_calls, 1);
    assert.equal(parsed.groups[0].key, 'claude-opus-5');

    const csv = await runCli(['spend', '--db', server.dbPath, '--csv']);
    assert.match(csv.stdout.split(String.fromCharCode(10))[0], /^key,calls,/);
  } finally {
    await server.stop();
    await upstream.close();
    removeTempDir(server.dbPath);
  }
});

test('`export` and `assert` operate on a recorded run', async () => {
  const upstream = await startMockUpstream((req, res) =>
    jsonResponse(res, 200, {
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 200 }
    })
  );
  const server = await startCliServer(['--anthropic-upstream', upstream.origin]);

  try {
    await recordOneCall(server);

    // export writes a file and reports what it wrote; it does not stream JSON.
    const outFile = path.join(server.dir, 'exported.json');
    const exported = await runCli(['export', 'cli-test-run', '--db', server.dbPath, '-o', outFile]);
    assert.equal(exported.code, 0, exported.output);
    assert.match(exported.stdout, /wrote /);

    const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(payload.run.id, 'cli-test-run');
    assert.equal(payload.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(payload), /x-api-key|authorization/i, 'an export must not carry credentials');

    // A generous ceiling passes; a zero ceiling has to fail, or the CI gate is
    // decorative.
    const ok = await runCli(['assert', 'cli-test-run', '--db', server.dbPath, '--max-cost', '10']);
    assert.equal(ok.code, 0, ok.output);
    assert.match(ok.stdout, /assertions passed/);

    const bad = await runCli(['assert', 'cli-test-run', '--db', server.dbPath, '--max-cost', '0']);
    assert.equal(bad.code, 1);
    assert.match(bad.output, /assertions failed/);
    assert.match(bad.output, /cost/);
  } finally {
    await server.stop();
    await upstream.close();
    removeTempDir(server.dbPath);
  }
});

test('`doctor` reports every provider and exits clean on a healthy install', async () => {
  const result = await runCli(['doctor']);
  assert.equal(result.code, 0, result.output);

  for (const provider of ['anthropic', 'openai', 'gemini', 'ollama', 'bedrock']) {
    assert.match(result.stdout, new RegExp(`provider ${provider}`), `doctor omits ${provider}`);
  }
  assert.match(result.stdout, /orangebox\s+v\d+\.\d+\.\d+/);
  assert.match(result.stdout, /pricing table/);
  assert.doesNotMatch(result.stdout, /FAIL/);
});

test('`doctor --json` is machine-readable and names no secrets', async () => {
  const result = await runCli(['doctor', '--json'], {
    env: { ANTHROPIC_API_KEY: 'sk-ant-canary-doctor' }
  });
  assert.equal(result.code, 0, result.output);

  const report = JSON.parse(result.stdout);
  assert.ok(['ok', 'note', 'warn'].includes(report.status), `unexpected status ${report.status}`);
  assert.ok(report.checks.length >= 8);

  const anthropic = report.checks.find((c) => c.provider === 'anthropic');
  assert.match(anthropic.detail, /ANTHROPIC_API_KEY/, 'credits the variable that supplied the key');
  assert.doesNotMatch(result.stdout, /sk-ant-canary-doctor/, 'a key value must never be printed');
});

test('`tools` reports tool usage from a recorded database', async () => {
  const upstream = await startMockUpstream((req, res) =>
    jsonResponse(res, 200, {
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 20 },
      content: [
        { type: 'text', text: 'looking' },
        { type: 'tool_use', id: 'tu_1', name: 'grep_repo', input: { pattern: 'TODO' } }
      ]
    })
  );
  const server = await startCliServer(['--anthropic-upstream', upstream.origin]);

  try {
    await recordOneCall(server);

    const table = await runCli(['tools', '--db', server.dbPath]);
    assert.equal(table.code, 0, table.output);
    assert.match(table.stdout, /grep_repo/);
    assert.match(table.stdout, /tool call\(s\)/);

    const json = await runCli(['tools', '--db', server.dbPath, '--json']);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.tools[0].key, 'grep_repo');
    assert.equal(parsed.total_uses, 1);

    const csv = await runCli(['tools', '--db', server.dbPath, '--csv']);
    assert.match(csv.stdout.split(String.fromCharCode(10))[0], /^tool,uses,runs,errors,unanswered/);
  } finally {
    await server.stop();
    await upstream.close();
    removeTempDir(server.dbPath);
  }
});

test('`tools` on an empty database says so instead of printing a blank table', async () => {
  const server = await startCliServer();
  try {
    const result = await runCli(['tools', '--db', server.dbPath]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No tool calls recorded/);
  } finally {
    await server.stop();
    removeTempDir(server.dbPath);
  }
});

test('`find` searches recorded content and reports where it matched', async () => {
  const upstream = await startMockUpstream((req, res) =>
    jsonResponse(res, 200, {
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'text', text: 'the migration lock was still held' }]
    })
  );
  const server = await startCliServer(['--anthropic-upstream', upstream.origin]);

  try {
    await recordOneCall(server);

    const hit = await runCli(['find', 'migration lock', '--db', server.dbPath]);
    assert.equal(hit.code, 0, hit.output);
    assert.match(hit.stdout, /migration lock/);
    assert.match(hit.stdout, /response/);
    assert.match(hit.stdout, /1 match/);

    // The snippet must survive whitespace collapsing intact. A mangled regex
    // here once deleted every letter s from the output.
    assert.match(hit.stdout, /was still held/);

    const miss = await runCli(['find', 'nothing-like-this-exists', '--db', server.dbPath]);
    assert.equal(miss.code, 0);
    assert.match(miss.stdout, /no recorded call contains/);

    const json = await runCli(['find', 'migration', '--db', server.dbPath, '--json']);
    assert.equal(JSON.parse(json.stdout).total, 1);
  } finally {
    await server.stop();
    await upstream.close();
    removeTempDir(server.dbPath);
  }
});

test('`find` with no search text explains itself instead of dumping the database', async () => {
  const result = await runCli(['find']);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /usage: orangebox find/);
});

test('`errors` reports a clean database as clean', async () => {
  const server = await startCliServer();
  try {
    const result = await runCli(['errors', '--db', server.dbPath]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No calls recorded/);
  } finally {
    await server.stop();
    removeTempDir(server.dbPath);
  }
});
