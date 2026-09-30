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
  assert.deepEqual(result.counts, { unanswered: 0, truncated: 2, loop: 1, growth: 0 });
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

test('a growth finding names the tool behind it when one dominates', async () => {
  // "cache it" and "stop re-reading that file" are different actions, and the
  // finding is the line somebody acts on.
  const { dominantTool } = await import('../src/diagnosis.mjs');
  const context = { calls: 12, growth: 9, cached_share: 0 };

  const named = findingsFor({ context, weight: { carried_tokens: 100, tools: [{ tool: 'read_file', carried_tokens: 80 }] } });
  assert.match(named[0].text, /mostly re-sent read_file results/);
  assert.equal(named[0].tool, 'read_file');

  const spread = findingsFor({ context, weight: { carried_tokens: 100, tools: [{ tool: 'a', carried_tokens: 45 }, { tool: 'b', carried_tokens: 55 }].reverse() } });
  assert.equal(spread[0].tool, 'b', 'a majority is enough');

  assert.equal(dominantTool({ carried_tokens: 100, tools: [{ tool: 'a', carried_tokens: 49 }] }), null);
  assert.equal(findingsFor({ context })[0].tool, null, 'no tool data, no claim');
});

test('a finding that points at a call says which', () => {
  const findings = findingsFor({
    truncations: { truncated_calls: 2, calls: [{ id: 'first-cut' }, { id: 'second-cut' }] },
    loops: { loops: [{ count: 3, call_ids: ['ask-1', 'ask-2', 'ask-3'] }], wasted_usd: 0.02 }
  });
  const byKind = Object.fromEntries(findings.map((f) => [f.kind, f]));
  assert.equal(byKind.truncated.call_id, 'first-cut');
  // The first repeat, not the original ask — that is where it went wrong.
  assert.equal(byKind.loop.call_id, 'ask-2');
});

test('a tool call nobody answered is a finding, weighted with a cut-off answer', async () => {
  const { unansweredTools } = await import('../src/diagnosis.mjs');
  const now = Date.UTC(2026, 8, 30, 12);
  const old = now - 60 * 60_000;
  const calls = [{ id: 'c1', seq: 1, started_at: old }, { id: 'c2', seq: 2, started_at: old + 1000 }];
  const tools = [
    { kind: 'tool_use', call_id: 'c1', tool_use_id: 'a' },
    { kind: 'tool_result', call_id: 'c2', tool_use_id: 'a' },
    { kind: 'tool_use', call_id: 'c2', tool_use_id: 'b' } // asked for, never answered, run gone quiet
  ];

  const open = unansweredTools(calls, tools, { now });
  assert.deepEqual(open, { count: 1, call_id: 'c2' });

  const [finding] = findingsFor({ unanswered: open });
  assert.equal(finding.kind, 'unanswered');
  assert.match(finding.text, /1 tool call never got a result/);

  const ranked = rankDiagnoses([
    { run: { id: 'loop', started_at: 2 }, findings: [{ kind: 'loop' }] },
    { run: { id: 'open', started_at: 1 }, findings: [{ kind: 'unanswered' }] }
  ]);
  assert.equal(ranked[0].run.id, 'open');
});

test('a run still going is not accused of ignoring its latest tool request', async () => {
  // Its results simply have not been sent yet.
  const { unansweredTools } = await import('../src/diagnosis.mjs');
  const now = Date.UTC(2026, 8, 30, 12);
  const calls = [{ id: 'c1', seq: 1, started_at: now - 30_000 }];
  const tools = [{ kind: 'tool_use', call_id: 'c1', tool_use_id: 'x' }];
  assert.equal(unansweredTools(calls, tools, { now }).count, 0);

  // An hour later with nothing more, it was abandoned.
  assert.equal(unansweredTools(calls, tools, { now: now + 60 * 60_000 }).count, 1);
});

test('a loop finding says what the repeats cost', () => {
  const [costly] = findingsFor({ loops: { loops: [{ count: 6, call_ids: ['a', 'b'] }], wasted_usd: 0.091 } });
  assert.match(costly.text, /6 calls asked the same thing, \$0\.091 in repeats/);

  // Too small to be worth a figure, or not known: no "$0".
  const [free] = findingsFor({ loops: { loops: [{ count: 3, call_ids: ['a'] }], wasted_usd: 0 } });
  assert.equal(free.text, '3 calls asked the same thing');
});
