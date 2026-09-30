// §31 — which tools the prompt is carrying.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolWeight, estimateTokens } from '../src/tool-weight.mjs';

const call = (seq, input = 1000) => ({ id: `c${seq}`, seq, input_tokens: input });
const use = (seq, id, name) => ({ kind: 'tool_use', call_id: `c${seq}`, tool_use_id: id, tool_name: name });
const result = (seq, id, bytes) => ({ kind: 'tool_result', call_id: `c${seq}`, tool_use_id: id, tool_name: null, content_json: 'x'.repeat(bytes) });

test('tokens are estimated from bytes, at four to one', () => {
  assert.equal(estimateTokens('x'.repeat(400)), 100);
  assert.equal(estimateTokens('x'.repeat(401)), 101, 'rounded up — a partial token is still sent');
  assert.equal(estimateTokens(null), 0);
});

test('a result is weighed by how many calls carried it, not by its size alone', () => {
  // Read at call 2 of 10: sent in call 2 and in each of the eight after it.
  const calls = Array.from({ length: 10 }, (_, i) => call(i + 1));
  const weight = toolWeight(calls, [use(1, 't1', 'read_file'), result(2, 't1', 4000)]);

  assert.equal(weight.tools[0].tokens, 1000);
  assert.equal(weight.tools[0].carried_tokens, 9000);
});

test('an early small result can outweigh a late large one', () => {
  // That is the whole point of carrying rather than sizing.
  const calls = Array.from({ length: 20 }, (_, i) => call(i + 1));
  const weight = toolWeight(calls, [
    use(1, 'a', 'list_dir'), result(2, 'a', 2000),   // 500 tokens × 19 sends
    use(18, 'b', 'read_file'), result(19, 'b', 8000) // 2000 tokens × 2 sends
  ]);
  assert.deepEqual(weight.tools.map((t) => t.tool), ['list_dir', 'read_file']);
});

test('results are named by the tool_use that asked for them', () => {
  const weight = toolWeight([call(1), call(2)], [use(1, 'x', 'search'), result(2, 'x', 40)]);
  assert.equal(weight.tools[0].tool, 'search');
});

test('an unpaired result still counts, under a name that says so', () => {
  const weight = toolWeight([call(1)], [result(1, 'orphan', 40)]);
  assert.equal(weight.tools[0].tool, '(unnamed tool)');
});

test('results from the same tool are summed, and the largest is kept', () => {
  const calls = [call(1), call(2), call(3)];
  const weight = toolWeight(calls, [
    use(1, 'a', 'read_file'), result(2, 'a', 400),
    use(2, 'b', 'read_file'), result(3, 'b', 4000)
  ]);
  const [entry] = weight.tools;
  assert.equal(entry.results, 2);
  assert.equal(entry.tokens, 1100);
  assert.equal(entry.largest_tokens, 1000);
});

test('the share of everything sent is capped at all of it', () => {
  // An estimate of part of a total must never read as more than the total.
  const weight = toolWeight([call(1, 10), call(2, 10)], [use(1, 'a', 'x'), result(1, 'a', 40000)]);
  assert.equal(weight.share_of_input, 1);
});

test('a run with no tools weighs nothing and says so', () => {
  const weight = toolWeight([call(1)], []);
  assert.equal(weight.results, 0);
  assert.deepEqual(weight.tools, []);
  assert.equal(weight.estimated, true);
});

test('toolWeightIn reads a real run, naming results by their tool', async () => {
  const { Store, newId } = await import('../src/store.mjs');
  const store = new Store(':memory:');
  try {
    const run = store.createRun({ name: 'reader', source: 'explicit' });
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = newId();
      ids.push(id);
      const events = [];
      if (i === 0) events.push({ id: newId(), run_id: run.id, call_id: id, kind: 'tool_use', tool_name: 'read_file', tool_use_id: 'tu_1', is_error: 0, content_json: '{}' });
      if (i === 1) events.push({ id: newId(), run_id: run.id, call_id: id, kind: 'tool_result', tool_name: null, tool_use_id: 'tu_1', is_error: 0, content_json: JSON.stringify('y'.repeat(3998)) });
      store.insertCall({
        id, run_id: run.id, seq: store.nextSeq(run.id), provider: 'anthropic', endpoint: '/v1/messages',
        model: 'claude-opus-5', started_at: Date.now() + i, input_tokens: 2000, request_json: '{}'
      }, events);
    }

    const weight = store.toolWeightIn(run.id);
    assert.equal(weight.tools[0].tool, 'read_file');
    assert.equal(weight.tools[0].tokens, 1000);
    assert.equal(weight.tools[0].carried_tokens, 4000, 'arrived at call 2 of 5, so sent four times');
  } finally {
    store.close();
  }
});

test('GET /api/runs/:id/tool-weight answers with the same shape as the store', async () => {
  const { startOrangebox } = await import('./helpers.mjs');
  const { newId } = await import('../src/store.mjs');
  const app = await startOrangebox({});
  try {
    const run = app.store.createRun({ name: 'x', source: 'explicit' });
    app.store.insertCall({
      id: newId(), run_id: run.id, seq: 1, provider: 'anthropic', endpoint: '/v1/messages',
      started_at: Date.now(), input_tokens: 10, request_json: '{}'
    });
    const body = await (await fetch(`${app.origin}/api/runs/${run.id}/tool-weight`)).json();
    assert.deepEqual(body, app.store.toolWeightIn(run.id));
    assert.equal((await fetch(`${app.origin}/api/runs/nope/tool-weight`)).status, 404);
  } finally {
    await app.stop();
  }
});
