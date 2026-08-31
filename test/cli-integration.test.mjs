// The CLI as a person meets it: a real subprocess, real flags, real banner.
//
// The in-process tests build a server by calling createServer() with a
// providers map already assembled. That skips the code turning flags into
// configuration, which is exactly where three providers were silently broken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli, startCliServer, removeTempDir } from './helpers.mjs';

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
