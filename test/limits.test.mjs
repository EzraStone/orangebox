// CI thresholds from a file, so a pipeline does not carry a paragraph of flags.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readLimitsFile, ASSERT_LIMITS } from '../src/cli.mjs';
import { runCli, startCliServer, removeTempDir } from './helpers.mjs';

test('a limits file uses the flag names, without their dashes', () => {
  const limits = readLimitsFile(JSON.stringify({
    'max-cost': 0.25, 'max-truncated': 0, 'max-context-growth': 8.5, 'require-known-cost': true
  }), 'x.json');
  assert.deepEqual(limits, { maxCost: 0.25, maxTruncated: 0, maxContextGrowth: 8.5, requireKnownCost: true });
});

test('every threshold a flag can set, a file can set too', () => {
  const all = Object.fromEntries(ASSERT_LIMITS.map(({ flag, kind }) => [flag.slice(2), kind === 'switch' ? true : 1]));
  const limits = readLimitsFile(JSON.stringify(all), 'x.json');
  assert.equal(Object.keys(limits).length, ASSERT_LIMITS.length);
});

test('a misspelled threshold is refused, not ignored', () => {
  // Ignoring it would switch the gate off and turn the build green for the
  // one reason it should not be.
  assert.throws(() => readLimitsFile('{"max-truncate": 0}', 'ci.json'), /unknown threshold "max-truncate".*max-truncated/);
});

test('a value of the wrong kind is refused with what was wanted', () => {
  assert.throws(() => readLimitsFile('{"max-calls": 2.5}', 'ci.json'), /"max-calls" must be a whole number, got 2.5/);
  assert.throws(() => readLimitsFile('{"max-cost": "0.25"}', 'ci.json'), /"max-cost" must be a number/);
  assert.throws(() => readLimitsFile('{"max-cost": -1}', 'ci.json'), /"max-cost" must be a number/);
  assert.throws(() => readLimitsFile('{"require-known-cost": "yes"}', 'ci.json'), /must be true or false/);
  assert.throws(() => readLimitsFile('[1, 2]', 'ci.json'), /must be a JSON object/);
  assert.throws(() => readLimitsFile('{nope', 'ci.json'), /ci.json is not valid JSON/);
});

test('comments and a schema key are allowed', () => {
  assert.deepEqual(readLimitsFile('{"$schema": "x", "_comment": "why", "max-errors": 0}', 'x.json'), { maxErrors: 0 });
});

test('`assert` reads the file, and a flag beats it', async () => {
  const server = await startCliServer();
  const dir = fs.mkdtempSync(path.join(path.dirname(server.dbPath), 'limits-'));
  try {
    const { openStore } = await import('../src/store.mjs');
    const store = openStore(server.dbPath);
    const run = store.createRun({ name: 'gated', source: 'explicit' });
    store.insertCall({
      id: 'l-1', run_id: run.id, seq: 1, provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
      started_at: Date.now(), input_tokens: 100, output_tokens: 10, cost_usd: 0.5, stop_reason: 'max_tokens', request_json: '{}'
    });
    store.close();

    const named = path.join(dir, 'ci-limits.json');
    fs.writeFileSync(named, JSON.stringify({ 'max-truncated': 0, 'max-cost': 10 }));

    const failed = await runCli(['assert', run.id, '--db', server.dbPath, '--limits', named]);
    assert.equal(failed.code, 1, failed.output);
    assert.match(failed.output, /limits from .*ci-limits\.json/);
    assert.match(failed.output, /cut off at the output limit/);

    // Loosen one threshold on the command line without touching the file.
    const loosened = await runCli(['assert', run.id, '--db', server.dbPath, '--limits', named, '--max-truncated', '1']);
    assert.equal(loosened.code, 0, loosened.output);

    // The default file is picked up from the working directory.
    fs.writeFileSync(path.join(dir, 'orangebox.limits.json'), JSON.stringify({ 'max-cost': 0.1 }));
    const picked = await runCli(['assert', run.id, '--db', server.dbPath, '--json'], { cwd: dir });
    const body = JSON.parse(picked.stdout);
    assert.equal(body.limits_file, 'orangebox.limits.json');
    assert.equal(body.ok, false);

    // A named file that is not there is an error, not a silent pass.
    const missing = await runCli(['assert', run.id, '--db', server.dbPath, '--limits', path.join(dir, 'nope.json')]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.output, /cannot read limits file/);
  } finally {
    await server.stop();
    removeTempDir(server.dbPath);
  }
});

test('`assert` with no limits at all says it checked nothing', async () => {
  // A pass with no thresholds looks exactly like a pass with real ones.
  const server = await startCliServer();
  const dir = fs.mkdtempSync(path.join(path.dirname(server.dbPath), 'nolimits-'));
  try {
    const { openStore } = await import('../src/store.mjs');
    const store = openStore(server.dbPath);
    const run = store.createRun({ name: 'ungated', source: 'explicit' });
    store.close();

    const result = await runCli(['assert', run.id, '--db', server.dbPath], { cwd: dir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no limits were set, so nothing was checked/);
  } finally {
    await server.stop();
    removeTempDir(server.dbPath);
  }
});
