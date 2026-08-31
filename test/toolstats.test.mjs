// §19.8 — tool behaviour across runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, newId } from '../src/store.mjs';

/** A run of calls, each optionally emitting tool_use / tool_result events. */
function build(spec) {
  const store = new Store(':memory:');
  const run = store.createRun({ source: 'gap', started_at: 1_000_000 });

  spec.forEach((step, i) => {
    const callId = newId();
    const started = 1_000_000 + i * 10_000;
    const events = [];

    for (const use of step.uses ?? []) {
      events.push({
        id: newId(), run_id: run.id, call_id: callId,
        kind: 'tool_use', tool_name: use.name, tool_use_id: use.id,
        is_error: 0, content_json: '{}'
      });
    }
    for (const result of step.results ?? []) {
      events.push({
        id: newId(), run_id: run.id, call_id: callId,
        kind: 'tool_result', tool_name: null, tool_use_id: result.id,
        is_error: result.error ? 1 : 0, content_json: '{}'
      });
    }

    store.insertCall({
      id: callId, run_id: run.id, seq: store.nextSeq(run.id),
      provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
      started_at: started,
      ended_at: started + (step.duration ?? 1000),
      request_json: '{}'
    }, events);
  });

  return { store, run };
}

test('a tool is counted per use, across runs', () => {
  const { store } = build([
    { uses: [{ name: 'search', id: 'a' }] },
    { results: [{ id: 'a' }], uses: [{ name: 'search', id: 'b' }] },
    { results: [{ id: 'b' }] }
  ]);

  const stats = store.toolStats({});
  assert.equal(stats.total_uses, 2);
  assert.equal(stats.tools.length, 1);
  assert.equal(stats.tools[0].key, 'search');
  assert.equal(stats.tools[0].uses, 2);
  assert.equal(stats.tools[0].runs, 1);
  store.close();
});

test('a failed tool result is counted against the tool that asked', () => {
  const { store } = build([
    { uses: [{ name: 'read_file', id: 'x' }] },
    { results: [{ id: 'x', error: true }], uses: [{ name: 'read_file', id: 'y' }] },
    { results: [{ id: 'y' }] }
  ]);

  const [tool] = store.toolStats({}).tools;
  assert.equal(tool.uses, 2);
  assert.equal(tool.errors, 1);
  assert.equal(tool.error_rate, 0.5);
  store.close();
});

test('a tool call that never got an answer is reported (§19.8)', () => {
  // The agent asked and nothing came back — the loop broke, the process died,
  // or the run was cut off mid-turn. It is invisible on a timeline unless you
  // go looking for the missing half.
  const { store } = build([
    { uses: [{ name: 'fetch', id: 'answered' }] },
    { results: [{ id: 'answered' }], uses: [{ name: 'fetch', id: 'dropped' }] }
  ]);

  const stats = store.toolStats({});
  const [tool] = stats.tools;
  assert.equal(tool.uses, 2);
  assert.equal(tool.unanswered, 1);
  assert.equal(stats.total_unanswered, 1);
  store.close();
});

test('timing comes only from calls that requested a single tool (§19.8)', () => {
  // orangebox never sees a tool run. The only clock it has is the hole between
  // two calls, and when a call asks for three tools that hole covers all
  // three. Splitting it evenly would invent data, so shared gaps are excluded
  // from the average entirely and the sample size is reported instead.
  const { store } = build([
    // one tool, 9s hole before the next call starts -> timed
    { uses: [{ name: 'slow_tool', id: 's1' }], duration: 1000 },
    // three tools at once -> the gap is unattributable, so not timed
    {
      results: [{ id: 's1' }],
      uses: [
        { name: 'slow_tool', id: 's2' },
        { name: 'other', id: 'o1' },
        { name: 'third', id: 't1' }
      ],
      duration: 1000
    },
    { results: [{ id: 's2' }, { id: 'o1' }, { id: 't1' }] }
  ]);

  const stats = store.toolStats({});
  const slow = stats.tools.find((t) => t.key === 'slow_tool');

  assert.equal(slow.uses, 2, 'both uses are counted');
  assert.equal(slow.timed_uses, 1, 'only the solo use contributes timing');
  assert.equal(slow.avg_ms, 9000, 'the gap is the 10s stride minus the 1s call');

  const other = stats.tools.find((t) => t.key === 'other');
  assert.equal(other.uses, 1);
  assert.equal(other.timed_uses, 0, 'a tool only ever seen alongside others has no timing');
  assert.equal(other.avg_ms, null, 'and reports null rather than a made-up number');
  store.close();
});

test('the last call in a run has no following gap to measure', () => {
  const { store } = build([{ uses: [{ name: 'only', id: 'z' }] }]);
  const [tool] = store.toolStats({}).tools;
  assert.equal(tool.uses, 1);
  assert.equal(tool.timed_uses, 0);
  assert.equal(tool.avg_ms, null);
  assert.equal(tool.slowest_ms, null);
  store.close();
});

test('the slowest single use is kept alongside the average', () => {
  const { store } = build([
    { uses: [{ name: 'x', id: '1' }], duration: 1000 },
    { results: [{ id: '1' }], uses: [{ name: 'x', id: '2' }], duration: 9000 },
    { results: [{ id: '2' }] }
  ]);
  const [tool] = store.toolStats({}).tools;
  assert.equal(tool.timed_uses, 2);
  assert.equal(tool.slowest_ms, 9000);
  assert.equal(tool.avg_ms, 5000);
  store.close();
});

test('tools are ranked by how often they are used', () => {
  const { store } = build([
    { uses: [{ name: 'rare', id: 'r' }, { name: 'common', id: 'c1' }] },
    { uses: [{ name: 'common', id: 'c2' }] },
    { uses: [{ name: 'common', id: 'c3' }] }
  ]);
  assert.deepEqual(store.toolStats({}).tools.map((t) => t.key), ['common', 'rare']);
  store.close();
});

test('an unnamed tool still gets a row rather than vanishing', () => {
  const { store } = build([{ uses: [{ name: null, id: 'n' }] }]);
  const [tool] = store.toolStats({}).tools;
  assert.equal(tool.key, '(unnamed tool)');
  store.close();
});

test('a window excludes calls outside it', () => {
  const { store } = build([
    { uses: [{ name: 'a', id: '1' }] },
    { uses: [{ name: 'a', id: '2' }] }
  ]);
  // The build helper starts at 1_000_000 with a 10s stride.
  assert.equal(store.toolStats({}).total_uses, 2);
  assert.equal(store.toolStats({ since: 1_005_000 }).total_uses, 1);
  assert.equal(store.toolStats({ until: 1_005_000 }).total_uses, 1);
  assert.equal(store.toolStats({ since: 2_000_000 }).total_uses, 0);
  store.close();
});

test('an empty database reports zeroes, not a crash', () => {
  const store = new Store(':memory:');
  const stats = store.toolStats({});
  assert.equal(stats.total_uses, 0);
  assert.deepEqual(stats.tools, []);
  store.close();
});

test('GET /api/tools answers with the same shape as the store (§19.8)', async () => {
  const { startOrangebox, removeTempDir } = await import('./helpers.mjs');
  const app = await startOrangebox({});

  try {
    const run = app.store.createRun({ source: 'gap' });
    const callId = newId();
    app.store.insertCall(
      {
        id: callId, run_id: run.id, seq: app.store.nextSeq(run.id),
        provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
        started_at: Date.now(), ended_at: Date.now() + 500, request_json: '{}'
      },
      [{
        id: newId(), run_id: run.id, call_id: callId,
        kind: 'tool_use', tool_name: 'grep_repo', tool_use_id: 'u1',
        is_error: 0, content_json: '{}'
      }]
    );

    const res = await fetch(`${app.origin}/api/tools`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.total_uses, 1);
    assert.equal(body.tools[0].key, 'grep_repo');
    assert.equal(body.tools[0].unanswered, 1, 'no result was ever recorded for it');

    // The window parameters accept a date as readily as epoch ms.
    const empty = await (await fetch(`${app.origin}/api/tools?since=2099-01-01`)).json();
    assert.equal(empty.total_uses, 0);
  } finally {
    await app.close();
    removeTempDir(app.dbPath);
  }
});
