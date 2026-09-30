// §25 — watching calls arrive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, newId } from '../src/store.mjs';
import { formatTailLine } from '../src/cli.mjs';

function withCalls(specs) {
  const store = new Store(':memory:');
  const run = store.createRun({ id: 'r1', name: 'a run', source: 'gap', started_at: 1000 });
  specs.forEach((spec, i) => {
    store.insertCall({
      id: spec.id ?? `c${i}`,
      run_id: run.id,
      seq: i + 1,
      provider: 'anthropic',
      endpoint: '/v1/messages',
      model: 'claude-opus-5',
      started_at: spec.at,
      request_json: '{}'
    });
  });
  return store;
}

test('callsSince returns only what is newer, oldest first', () => {
  const store = withCalls([{ at: 100 }, { at: 200 }, { at: 300 }]);

  assert.equal(store.callsSince({}).length, 3);
  assert.deepEqual(store.callsSince({ after: 100 }).map((c) => c.started_at), [200, 300]);
  assert.deepEqual(store.callsSince({ after: 300 }).map((c) => c.started_at), []);
  store.close();
});

test('two calls recorded in the same millisecond are not skipped', () => {
  // Calls are written in completion order, so ties are routine — keying on
  // time alone would silently drop one every time a run finishes fast.
  const store = withCalls([
    { at: 500, id: 'aaa' },
    { at: 500, id: 'bbb' },
    { at: 500, id: 'ccc' }
  ]);

  const after = store.callsSince({ after: 500, afterId: 'aaa' });
  assert.deepEqual(after.map((c) => c.id), ['bbb', 'ccc'], 'the later ties still arrive');

  const last = store.callsSince({ after: 500, afterId: 'ccc' });
  assert.deepEqual(last, [], 'and nothing repeats once caught up');
  store.close();
});

test('following never replays a call twice', () => {
  // The property that matters for a tail: walk the cursor forward the way the
  // command does and assert every call appears exactly once.
  const store = withCalls([{ at: 10 }, { at: 10 }, { at: 20 }, { at: 30 }, { at: 30 }]);

  const seen = [];
  let cursor = null;
  for (let poll = 0; poll < 10; poll++) {
    const fresh = store.callsSince({ after: cursor?.started_at ?? 0, afterId: cursor?.id ?? null });
    for (const call of fresh) {
      seen.push(call.id);
      cursor = call;
    }
  }

  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5, `a call was replayed: ${seen.join(', ')}`);
  store.close();
});

test('callsSince carries the run name, so a tail line can say where a call came from', () => {
  const store = withCalls([{ at: 100 }]);
  assert.equal(store.callsSince({})[0].run_name, 'a run');
  store.close();
});

test('a tail line reads when, where, what, and how it went', () => {
  const line = formatTailLine({
    started_at: Date.UTC(2026, 8, 28, 14, 30, 5),
    run_name: 'checkout bot',
    model: 'claude-opus-5',
    latency_ms: 1234,
    input_tokens: 1800,
    output_tokens: 96,
    cost_usd: 0.0122,
    stop_reason: 'tool_use',
    streamed: 1,
    error_type: null
  });

  assert.match(line, /14:30:05/);
  assert.match(line, /checkout bot/);
  assert.match(line, /claude-opus-5/);
  assert.match(line, /1234 ms/);
  assert.match(line, /1800→96/);
  assert.match(line, /stream/);
  assert.match(line, /tool_use/);
});

test('an errored call shows the error rather than a stop reason', () => {
  const line = formatTailLine({
    started_at: Date.UTC(2026, 8, 28, 14, 30, 5),
    run_name: 'r', model: 'm', latency_ms: null,
    input_tokens: null, output_tokens: null, cost_usd: null,
    stop_reason: null, streamed: 0, error_type: 'upstream_error'
  });

  assert.match(line, /upstream_error/);
  // A call that never finished has no latency; an em-dash says so rather than
  // implying it took zero milliseconds.
  assert.match(line, /—/);
  assert.match(line, /0→0/);
});

test('a noted call says so in the tail', () => {
  const line = formatTailLine({
    started_at: Date.now(), run_name: 'r', model: 'm', latency_ms: 10,
    input_tokens: 1, output_tokens: 1, cost_usd: 0, stop_reason: 'end_turn',
    streamed: 0, error_type: null, note: 'look at this one'
  });
  assert.match(line, /noted/);
});

test('a cut-off answer stands out in tail, whatever the provider called it', () => {
  // Scrolling past at speed, "length" reads as a normal finish. It is the one
  // outcome that means the agent is about to act on half a response.
  const base = {
    started_at: Date.UTC(2026, 8, 30, 12, 0, 0), run_name: 'agent', model: 'gpt-5.6-sol',
    latency_ms: 900, input_tokens: 100, output_tokens: 4096, cost_usd: 0.01
  };
  assert.match(formatTailLine({ ...base, provider: 'openai', stop_reason: 'length' }), /cut off \(length\)/);
  assert.match(formatTailLine({ ...base, provider: 'gemini', stop_reason: 'MAX_TOKENS' }), /cut off \(MAX_TOKENS\)/);

  const normal = formatTailLine({ ...base, provider: 'openai', stop_reason: 'stop' });
  assert.equal(normal.includes('cut off'), false);
  assert.match(normal, /stop$/);
});
