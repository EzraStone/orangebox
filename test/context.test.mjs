// §27 — context growth across a run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contextGrowth, sampleSeries, SERIES_WIDTH } from '../src/context.mjs';
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

test('GET /api/runs/:id/context answers with the same shape as the store', async () => {
  const { startOrangebox, removeTempDir } = await import('./helpers.mjs');
  const app = await startOrangebox({});

  try {
    const run = app.store.createRun({ name: 'growing', source: 'gap' });
    for (let i = 0; i < 8; i++) {
      app.store.insertCall({
        id: newId(), run_id: run.id, seq: app.store.nextSeq(run.id),
        provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
        started_at: Date.now() + i, input_tokens: 1500 * (i + 1), output_tokens: 40,
        request_json: '{}'
      });
    }

    const body = await (await fetch(`${app.origin}/api/runs/${run.id}/context`)).json();
    assert.deepEqual(body, app.store.contextGrowth(run.id));
    assert.equal(body.calls, 8);
    assert.equal(body.growth, 8);

    const missing = await fetch(`${app.origin}/api/runs/no-such-run/context`);
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
    removeTempDir(app.dbPath);
  }
});

test('a short run is drawn from every call it had', () => {
  assert.deepEqual(sampleSeries([5, 9, 2]), [5, 9, 2]);
  assert.deepEqual(sampleSeries([]), []);
});

test('a long run is sampled down to something drawable', () => {
  const values = Array.from({ length: 5000 }, (_, i) => i);
  assert.equal(sampleSeries(values).length, SERIES_WIDTH);
});

test('buckets keep their peak rather than their average', () => {
  // Averaging is precisely the operation that hides the spike you opened the
  // report to find.
  const values = [1, 1, 1, 400, 1, 1, 1, 1];
  assert.ok(sampleSeries(values, 2).includes(400));
});

test('every bucket is drawn from at least one call', () => {
  // Off-by-one here produces an undefined in the middle of the chart, which
  // renders as a gap and reads as missing data.
  const sampled = sampleSeries([3, 1, 4, 1, 5], 5);
  assert.equal(sampled.length, 5);
  assert.ok(sampled.every(Number.isFinite));
});

test('the growth report carries a drawable series', () => {
  const calls = Array.from({ length: 200 }, (_, i) => call(i + 1, 10 * (i + 1)));
  const result = contextGrowth(calls);
  assert.equal(result.series.length, SERIES_WIDTH);
  assert.equal(Math.max(...result.series), result.peak_tokens);
});

test('a run whose prompt ballooned can fail CI (§27)', async () => {
  const { evaluateRunAssertions } = await import('../src/assertions.mjs');
  const run = { cost_usd: 0.4, call_count: 10, error_count: 0, unknown_cost_count: 0 };
  const growth = contextGrowth(Array.from({ length: 10 }, (_, i) => call(i + 1, 1000 * (i + 1))));

  const strict = evaluateRunAssertions(run, [], { maxContextGrowth: 4 }, [], null, growth);
  assert.equal(strict.ok, false);
  assert.match(strict.failures[0], /grew 10\.0×/);
  assert.match(strict.failures[0], /exceeds 4×/);

  const lenient = evaluateRunAssertions(run, [], { maxContextGrowth: 20 }, [], null, growth);
  assert.equal(lenient.ok, true);

  // Without the flag, growth is measured but never fails the run.
  const unset = evaluateRunAssertions(run, [], {}, [], null, growth);
  assert.equal(unset.ok, true);
});

test('a run with no token counts cannot fail the growth gate', async () => {
  // Refusing to judge is the only honest answer when the provider reported no
  // usage; failing the build on a number orangebox never saw would be worse.
  const { evaluateRunAssertions } = await import('../src/assertions.mjs');
  const run = { cost_usd: 0, call_count: 3, error_count: 0, unknown_cost_count: 3 };
  const growth = contextGrowth([{ seq: 1, input_tokens: null }]);

  const result = evaluateRunAssertions(run, [], { maxContextGrowth: 1.5 }, [], null, growth);
  assert.equal(result.ok, true);
});
