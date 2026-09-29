// §26 — detecting an agent going in circles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, newId } from '../src/store.mjs';
import { promptFingerprint, findLoops } from '../src/loops.mjs';

const ask = (text, history = []) =>
  JSON.stringify({ messages: [...history, { role: 'user', content: text }] });

const call = (seq, request, cost = 0.01) => ({
  id: `c${seq}`, seq, request_json: request, cost_usd: cost
});

test('the fingerprint is the last instruction, not the whole conversation', () => {
  // The point of the whole feature. An agent loop resends a growing history
  // with the same final instruction — hashing everything makes every call
  // unique and finds nothing at all.
  const first = ask('read the logs');
  const later = ask('read the logs', [
    { role: 'user', content: 'earlier turn' },
    { role: 'assistant', content: 'a long previous answer' }
  ]);

  assert.equal(promptFingerprint(first), promptFingerprint(later));
});

test('formatting differences are not different instructions', () => {
  assert.equal(promptFingerprint(ask('Read The   Logs')), promptFingerprint(ask('read the logs')));
  assert.notEqual(promptFingerprint(ask('read the logs')), promptFingerprint(ask('read the config')));
});

test('every provider request shape is understood', () => {
  const expected = promptFingerprint(ask('read the logs'));

  // Gemini
  assert.equal(
    promptFingerprint(JSON.stringify({ contents: [{ parts: [{ text: 'read the logs' }] }] })),
    expected
  );
  // OpenAI Responses, bare string
  assert.equal(promptFingerprint(JSON.stringify({ input: 'read the logs' })), expected);
  // Content blocks rather than a string
  assert.equal(
    promptFingerprint(JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'read the logs' }] }] })),
    expected
  );
});

test('a tool result counts as content, so re-reading the same file is visible', () => {
  // The classic loop: the model calls a tool, gets the same answer, and asks
  // again. The repeated part is the tool result, not any prose.
  const request = JSON.stringify({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents here' }] }]
  });
  assert.ok(promptFingerprint(request));
});

test('an unreadable request fingerprints as nothing rather than throwing', () => {
  assert.equal(promptFingerprint('not json'), null);
  assert.equal(promptFingerprint(null), null);
  assert.equal(promptFingerprint(JSON.stringify({})), null);
  assert.equal(promptFingerprint(JSON.stringify({ messages: [] })), null);
});

test('a run with no repeats reports no loops', () => {
  const result = findLoops([call(1, ask('a')), call(2, ask('b')), call(3, ask('c'))]);
  assert.equal(result.loops.length, 0);
  assert.equal(result.wasted_usd, 0);
  assert.equal(result.total_calls, 3);
});

test('a repeated instruction is reported with what it cost (§26)', () => {
  // Four identical asks: the first was work, the other three were the loop.
  const calls = [1, 2, 3, 4].map((seq) => call(seq, ask('read the logs'), 0.02));
  const result = findLoops(calls);

  assert.equal(result.loops.length, 1);
  const [loop] = result.loops;

  assert.equal(loop.count, 4);
  assert.equal(loop.repeats, 3, 'the first ask is not a repeat');
  assert.equal(loop.consecutive, 4);
  assert.match(loop.prompt, /read the logs/);
  assert.equal(loop.cost_usd, 0.08);
  assert.equal(loop.wasted_usd, 0.06, 'three repeats at 0.02');
  assert.equal(result.wasted_usd, 0.06);
  assert.equal(result.looping_calls, 4);
});

test('scattered repeats are distinguished from a tight loop', () => {
  // The same question twice an hour apart is probably fine. Four in a row is
  // not, and the consecutive count is what separates them.
  const scattered = findLoops([
    call(1, ask('x')), call(2, ask('other')), call(3, ask('x')), call(4, ask('another')), call(5, ask('x'))
  ]);
  assert.equal(scattered.loops[0].count, 3);
  assert.equal(scattered.loops[0].consecutive, 1, 'never twice in a row');

  const tight = findLoops([call(1, ask('x')), call(2, ask('x')), call(3, ask('x'))]);
  assert.equal(tight.loops[0].consecutive, 3);
});

test('the worst loop is reported first', () => {
  const calls = [
    ...[1, 2].map((s) => call(s, ask('twice'), 0.01)),
    ...[3, 4, 5, 6].map((s) => call(s, ask('four times'), 0.01))
  ];
  const result = findLoops(calls);
  assert.equal(result.loops[0].repeats, 3);
  assert.match(result.loops[0].prompt, /four times/);
});

test('loopsIn reads a real run out of the store', () => {
  const store = new Store(':memory:');
  const run = store.createRun({ name: 'looping', source: 'gap' });

  for (let i = 0; i < 3; i++) {
    store.insertCall({
      id: newId(), run_id: run.id, seq: store.nextSeq(run.id),
      provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
      started_at: Date.now() + i, cost_usd: 0.05,
      request_json: ask('check the deploy status')
    });
  }

  const result = store.loopsIn(run.id);
  assert.equal(result.loops.length, 1);
  assert.equal(result.loops[0].repeats, 2);
  assert.equal(result.wasted_usd, 0.1);
  assert.equal(result.loops[0].call_ids.length, 3);
  store.close();
});

test('GET /api/runs/:id/loops answers with the same shape as the store', async () => {
  const { startOrangebox, removeTempDir } = await import('./helpers.mjs');
  const app = await startOrangebox({});

  try {
    const run = app.store.createRun({ name: 'circling', source: 'gap' });
    for (let i = 0; i < 3; i++) {
      app.store.insertCall({
        id: newId(), run_id: run.id, seq: app.store.nextSeq(run.id),
        provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
        started_at: Date.now() + i, cost_usd: 0.03,
        request_json: ask('are we there yet')
      });
    }

    const body = await (await fetch(`${app.origin}/api/runs/${run.id}/loops`)).json();
    assert.equal(body.loops.length, 1);
    assert.equal(body.loops[0].repeats, 2);
    assert.equal(body.wasted_usd, 0.06);

    // A higher threshold reports nothing rather than erroring.
    const strict = await (await fetch(`${app.origin}/api/runs/${run.id}/loops?min=5`)).json();
    assert.equal(strict.loops.length, 0);

    const missing = await fetch(`${app.origin}/api/runs/no-such-run/loops`);
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
    removeTempDir(app.dbPath);
  }
});

test('a healthy run is reported as having no loops, explicitly', async () => {
  // Saying "no repeated prompts" is the useful answer. An empty list reads as
  // a feature that did not run.
  const { startOrangebox, removeTempDir } = await import('./helpers.mjs');
  const app = await startOrangebox({});

  try {
    const run = app.store.createRun({ name: 'healthy', source: 'gap' });
    for (let i = 0; i < 4; i++) {
      app.store.insertCall({
        id: newId(), run_id: run.id, seq: app.store.nextSeq(run.id),
        provider: 'anthropic', endpoint: '/v1/messages',
        started_at: Date.now() + i, cost_usd: 0.01,
        request_json: ask(`step ${i}`)
      });
    }

    const body = await (await fetch(`${app.origin}/api/runs/${run.id}/loops`)).json();
    assert.equal(body.loops.length, 0);
    assert.equal(body.wasted_usd, 0);
    assert.equal(body.total_calls, 4, 'but it did look at every call');
  } finally {
    await app.close();
    removeTempDir(app.dbPath);
  }
});

test('CI can fail a run that went in circles (§19.6, §26)', async () => {
  // A loop passes every other gate: the run finishes, nothing errors, latency
  // is fine, and a cost ceiling only catches it once the bill is already large.
  const { evaluateRunAssertions } = await import('../src/assertions.mjs');

  const run = { cost_usd: 0.09, error_count: 0, call_count: 6, unknown_cost_count: 0 };
  const loops = findLoops([1, 2, 3, 4, 5, 6].map((seq) => call(seq, ask('check the deploy'), 0.015)));

  const strict = evaluateRunAssertions(run, [], { maxRepeats: 2 }, [], loops);
  assert.equal(strict.ok, false);
  assert.match(strict.failures[0], /repeated 5 time\(s\)/);
  assert.match(strict.failures[0], /check the deploy/, 'names the prompt, so CI logs are actionable');

  const lenient = evaluateRunAssertions(run, [], { maxRepeats: 10 }, [], loops);
  assert.equal(lenient.ok, true, 'a generous ceiling passes');

  // Without the flag, loops are reported but never fail the run.
  const unset = evaluateRunAssertions(run, [], {}, [], loops);
  assert.equal(unset.ok, true);
});

test('the loop gate does nothing when no loop data was gathered', () => {
  // The CLI only computes loops when the flag is present; the evaluator must
  // not assume it is always there.
  return import('../src/assertions.mjs').then(({ evaluateRunAssertions }) => {
    const run = { cost_usd: 0, error_count: 0, call_count: 1, unknown_cost_count: 0 };
    assert.equal(evaluateRunAssertions(run, [], { maxRepeats: 0 }, [], null).ok, true);
  });
});
