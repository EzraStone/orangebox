// §30 — every check, across runs, in one answer.
import test from 'node:test';
import assert from 'node:assert/strict';

import { findingsFor, rankDiagnoses, diagnose } from '../src/diagnosis.mjs';
import { Store, newId } from '../src/store.mjs';

test('a healthy run has no findings', () => {
  assert.deepEqual(findingsFor({
    truncations: { truncated_calls: 0 },
    loops: { loops: [], wasted_usd: 0 },
    context: { calls: 10, growth: 1.3, cached_share: 0 }
  }), []);
});

test('growth is only a finding when it is worth acting on', () => {
  // Growth is how multi-turn agents work. Listing every run that grew would
  // bury the ones that need looking at under the ones that are just agents.
  const steep = { calls: 12, growth: 9, cached_share: 0.02 };
  assert.equal(findingsFor({ context: steep })[0].kind, 'growth');
  assert.deepEqual(findingsFor({ context: { ...steep, cached_share: 0.9 } }), [], 'already cached');
  assert.deepEqual(findingsFor({ context: { ...steep, calls: 3 } }), [], 'too short to mean anything');
  assert.deepEqual(findingsFor({ context: { ...steep, growth: 2 } }), [], 'gentle');
});

test('a run is ranked by what is wrong with it, not by when it ran', () => {
  const entry = (id, startedAt, kinds) => ({ run: { id, started_at: startedAt }, findings: kinds.map((kind) => ({ kind })) });
  const ranked = rankDiagnoses([
    entry('recent-growth', 300, ['growth']),
    entry('old-truncated', 100, ['truncated']),
    entry('loop-and-growth', 200, ['loop', 'growth'])
  ]);
  // A cut-off answer means a wrong answer; a loop means a costly one.
  assert.deepEqual(ranked.map((e) => e.run.id), ['loop-and-growth', 'old-truncated', 'recent-growth']);
});

test('diagnose only lists runs with something to say, and counts by kind', () => {
  const analyses = {
    a: { truncations: { truncated_calls: 2 }, loops: { loops: [] }, context: null },
    b: { truncations: { truncated_calls: 0 }, loops: { loops: [] }, context: null },
    c: { truncations: { truncated_calls: 1 }, loops: { loops: [{ count: 4 }], wasted_usd: 0.1 }, context: null }
  };
  const result = diagnose([{ id: 'a' }, { id: 'b' }, { id: 'c' }], (id) => analyses[id]);

  assert.equal(result.checked_runs, 3);
  assert.equal(result.flagged_runs, 2);
  assert.deepEqual(result.counts, { truncated: 2, loop: 1, growth: 0 });
  assert.equal(result.runs[0].run.id, 'c');
});

test('store.diagnose reads real runs', () => {
  const store = new Store(':memory:');
  try {
    const add = (runId, i, stop, prompt) => store.insertCall({
      id: newId(), run_id: runId, seq: store.nextSeq(runId),
      provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
      started_at: Date.now() + i, input_tokens: 500, output_tokens: 100, cost_usd: 0.01, stop_reason: stop,
      request_json: JSON.stringify({ messages: [{ role: 'user', content: prompt }] })
    });

    const healthy = store.createRun({ name: 'healthy', source: 'explicit' });
    ['a', 'b', 'c'].forEach((p, i) => add(healthy.id, i, 'end_turn', p));

    const stuck = store.createRun({ name: 'stuck', source: 'explicit' });
    [0, 1, 2].forEach((i) => add(stuck.id, i, i === 2 ? 'max_tokens' : 'end_turn', 'check the deploy'));

    const result = store.diagnose();
    assert.equal(result.checked_runs, 2);
    assert.equal(result.flagged_runs, 1);
    assert.equal(result.runs[0].run.name, 'stuck');
    assert.deepEqual(result.runs[0].findings.map((f) => f.kind).sort(), ['loop', 'truncated']);
  } finally {
    store.close();
  }
});

test('GET /api/diagnosis answers with the same shape as the store', async () => {
  const { startOrangebox, removeTempDir } = await import('./helpers.mjs');
  const app = await startOrangebox({});
  try {
    const run = app.store.createRun({ name: 'cut', source: 'explicit' });
    app.store.insertCall({
      id: newId(), run_id: run.id, seq: 1, provider: 'openai', endpoint: '/v1/chat/completions',
      model: 'gpt-5.6-sol', started_at: Date.now(), stop_reason: 'length', request_json: '{}'
    });

    const body = await (await fetch(`${app.origin}/api/diagnosis`)).json();
    assert.deepEqual(body, JSON.parse(JSON.stringify(app.store.diagnose())));
    assert.equal(body.counts.truncated, 1);

    const future = await (await fetch(`${app.origin}/api/diagnosis?since=${Date.now() + 86_400_000}`)).json();
    assert.equal(future.checked_runs, 0);
  } finally {
    await app.close();
    removeTempDir(app.dbPath);
  }
});
