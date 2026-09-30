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
