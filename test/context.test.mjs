// §27 — context growth across a run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contextGrowth } from '../src/context.mjs';
import { Store, newId } from '../src/store.mjs';

const call = (seq, input, cached = 0) => ({ seq, input_tokens: input, cache_read_tokens: cached });

test('a growing conversation is measured from first to peak', () => {
  const result = contextGrowth([call(1, 1000), call(2, 2000), call(3, 4000), call(4, 8000)]);

  assert.equal(result.first_tokens, 1000);
  assert.equal(result.last_tokens, 8000);
  assert.equal(result.peak_tokens, 8000);
  assert.equal(result.total_input_tokens, 15000);
  assert.equal(result.growth, 8);
});

test('growth is measured against the peak, not the last call', () => {
  // An agent that grows and then starts a fresh sub-task ends small. Using the
  // final call would report no growth on a run that plainly had some.
  const result = contextGrowth([call(1, 1000), call(2, 20000), call(3, 1200)]);
  assert.equal(result.peak_tokens, 20000);
  assert.equal(result.growth, 20);
});

test('heavy growth with no caching is called out as worth fixing', () => {
  const calls = Array.from({ length: 10 }, (_, i) => call(i + 1, 1000 * (i + 1)));
  assert.match(contextGrowth(calls).verdict, /prompt caching would pay/);
});

test('heavy growth that was mostly cached is not', () => {
  // Same shape, but the provider served it from cache — there is nothing to do.
  const calls = Array.from({ length: 10 }, (_, i) => call(i + 1, 1000 * (i + 1), 950 * (i + 1)));
  const result = contextGrowth(calls);
  assert.ok(result.cached_share > 0.9);
  assert.match(result.verdict, /served from cache/);
  assert.doesNotMatch(result.verdict, /would pay/);
});

test('a short run is not lectured about caching', () => {
  // Three calls that grew is a conversation, not a problem. Saying otherwise
  // trains people to ignore the line entirely.
  const result = contextGrowth([call(1, 100), call(2, 5000), call(3, 40000)]);
  assert.match(result.verdict, /too few calls/);
});

test('the cached share can never exceed everything', () => {
  // Providers disagree about whether cache reads are included in input tokens.
  // A "137% cached" figure would rightly destroy trust in the whole number.
  const result = contextGrowth([call(1, 1000, 5000), call(2, 1000, 5000)]);
  assert.equal(result.cached_share, 1);
});

test('a run with no token counts says so rather than reporting zeros', () => {
  const result = contextGrowth([{ seq: 1, input_tokens: null }, { seq: 2, input_tokens: null }]);
  assert.equal(result.calls, 0);
  assert.equal(result.growth, null);
  assert.match(result.verdict, /not knowable|no token counts/);
});

test('calls are ordered by sequence, not by the order they were handed over', () => {
  // Calls are written in completion order, so a streamed call can land after a
  // later short one. Growth measured in arrival order would be nonsense.
  const result = contextGrowth([call(3, 9000), call(1, 1000), call(2, 3000)]);
  assert.equal(result.first_tokens, 1000);
  assert.equal(result.last_tokens, 9000);
});

test('contextGrowth reads a real run out of the store', () => {
  const store = new Store(':memory:');
  const run = store.createRun({ name: 'growing', source: 'gap' });
  for (let i = 0; i < 6; i++) {
    store.insertCall({
      id: newId(), run_id: run.id, seq: store.nextSeq(run.id),
      provider: 'anthropic', endpoint: '/v1/messages',
      started_at: Date.now() + i, input_tokens: 2000 * (i + 1), output_tokens: 50,
      request_json: '{}'
    });
  }

  const result = store.contextGrowth(run.id);
  assert.equal(result.calls, 6);
  assert.equal(result.first_tokens, 2000);
  assert.equal(result.peak_tokens, 12000);
  assert.equal(result.growth, 6);
  store.close();
});
