// §19.10 — failures grouped by what went wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, newId } from '../src/store.mjs';

function withCalls(specs) {
  const store = new Store(':memory:');
  const run = store.createRun({ source: 'gap', started_at: 1_000_000 });
  specs.forEach((spec, i) => {
    store.insertCall({
      id: newId(), run_id: spec.run ?? run.id, seq: i + 1,
      provider: spec.provider ?? 'anthropic',
      endpoint: '/v1/messages',
      model: spec.model ?? 'claude-opus-5',
      started_at: 1_000_000 + i * 1000,
      error_type: spec.error ?? null,
      request_json: '{}'
    });
  });
  return { store, run };
}

test('errors are grouped by type, most common first', () => {
  const { store } = withCalls([
    { error: 'http_429' }, { error: 'http_429' }, { error: 'http_429' },
    { error: 'client_aborted' },
    {}
  ]);

  const stats = store.errorStats({});
  assert.equal(stats.total_calls, 5);
  assert.equal(stats.total_errors, 4);
  assert.equal(stats.errors[0].key, 'http_429');
  assert.equal(stats.errors[0].count, 3);
  assert.equal(stats.errors[1].key, 'client_aborted');
  store.close();
});

test('share is reported against every call, not just the failed ones', () => {
  // A raw count says nothing alone: twelve timeouts out of twelve calls and
  // twelve out of nine thousand are completely different situations.
  const specs = Array.from({ length: 100 }, (_, i) => (i < 5 ? { error: 'http_500' } : {}));
  const { store } = withCalls(specs);

  const stats = store.errorStats({});
  assert.equal(stats.errors[0].count, 5);
  assert.equal(stats.errors[0].share, 0.05);
  assert.equal(stats.error_rate, 0.05);
  store.close();
});

test('an error seen across providers lists all of them', () => {
  const { store } = withCalls([
    { error: 'upstream_unreachable', provider: 'gemini' },
    { error: 'upstream_unreachable', provider: 'ollama' },
    { error: 'upstream_unreachable', provider: 'gemini' }
  ]);

  const [error] = store.errorStats({}).errors;
  assert.equal(error.count, 3);
  assert.deepEqual([...error.providers].sort(), ['gemini', 'ollama']);
  store.close();
});

test('the most recent example is kept so the error can be opened', () => {
  const { store } = withCalls([
    { error: 'http_429', model: 'old-model' },
    {},
    { error: 'http_429', model: 'new-model' }
  ]);

  const [error] = store.errorStats({}).errors;
  assert.equal(error.latest_model, 'new-model', 'the newest example, not the first');
  assert.ok(error.latest_call_id, 'and an id to open it with');
  assert.ok(error.last_seen > error.first_seen);
  store.close();
});

test('a clean database reports a zero rate rather than dividing by nothing', () => {
  const { store } = withCalls([{}, {}]);
  const stats = store.errorStats({});
  assert.equal(stats.total_errors, 0);
  assert.equal(stats.error_rate, 0);
  assert.deepEqual(stats.errors, []);
  store.close();
});

test('an empty database does not divide by zero', () => {
  const store = new Store(':memory:');
  const stats = store.errorStats({});
  assert.equal(stats.total_calls, 0);
  assert.equal(stats.error_rate, 0);
  store.close();
});

test('a window narrows both the errors and the denominator', () => {
  // The share has to be computed over the same window as the errors, or a
  // narrow window reports an impossibly small rate.
  const { store } = withCalls([
    { error: 'http_500' }, { error: 'http_500' }, {}, {}
  ]);
  const narrow = store.errorStats({ since: 1_002_000 });
  assert.equal(narrow.total_calls, 2, 'the denominator respects the window');
  assert.equal(narrow.total_errors, 0);
  store.close();
});
