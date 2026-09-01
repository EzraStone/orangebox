// The four cross-run views should behave the same way at the edges. They were
// written one at a time over a few days, which is exactly how four endpoints
// end up disagreeing about what an empty window means.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startOrangebox, removeTempDir } from './helpers.mjs';
import { newId } from '../src/store.mjs';

const ANALYTICS = ['/api/spend', '/api/tools', '/api/errors'];

async function withApp(run) {
  const app = await startOrangebox({});
  try {
    return await run(app);
  } finally {
    await app.close();
    removeTempDir(app.dbPath);
  }
}

function seed(app) {
  const run = app.store.createRun({ name: 'seeded', source: 'gap' });
  const callId = newId();
  app.store.insertCall(
    {
      id: callId, run_id: run.id, seq: 1,
      provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
      started_at: Date.now(), ended_at: Date.now() + 500,
      input_tokens: 100, output_tokens: 10, cost_usd: 0.001,
      error_type: 'http_429',
      request_json: JSON.stringify({ messages: [{ content: 'needle' }] })
    },
    [{
      id: newId(), run_id: run.id, call_id: callId,
      kind: 'tool_use', tool_name: 'search', tool_use_id: 'u1',
      is_error: 0, content_json: '{}'
    }]
  );
  return run;
}

test('every analytics endpoint answers on an empty database', async () => {
  // Not one of them should 500 or return null because there is nothing yet —
  // an empty database is the state every user starts in.
  await withApp(async (app) => {
    for (const path of [...ANALYTICS, '/api/search?q=anything']) {
      const res = await fetch(`${app.origin}${path}`);
      assert.equal(res.status, 200, `${path} did not answer`);
      const body = await res.json();
      assert.equal(typeof body, 'object', `${path} returned ${typeof body}`);
      assert.notEqual(body, null, `${path} returned null`);
    }
  });
});

test('every analytics endpoint accepts a date as readily as epoch ms', async () => {
  // `since` is documented as taking either. One endpoint parsing only numbers
  // would fail quietly by returning everything.
  await withApp(async (app) => {
    seed(app);
    for (const path of ANALYTICS) {
      const future = await (await fetch(`${app.origin}${path}?since=2099-01-01`)).json();
      const futureMs = await (await fetch(`${app.origin}${path}?since=${Date.parse('2099-01-01')}`)).json();
      assert.deepEqual(future, futureMs, `${path} treats a date differently from epoch ms`);
    }
  });
});

test('a window in the future empties every view, rather than being ignored', async () => {
  await withApp(async (app) => {
    seed(app);

    const spend = await (await fetch(`${app.origin}/api/spend?since=2099-01-01`)).json();
    assert.equal(spend.total_calls, 0);

    const tools = await (await fetch(`${app.origin}/api/tools?since=2099-01-01`)).json();
    assert.equal(tools.total_uses, 0);

    const errors = await (await fetch(`${app.origin}/api/errors?since=2099-01-01`)).json();
    assert.equal(errors.total_calls, 0);
    assert.equal(errors.error_rate, 0, 'and does not divide by zero on the way');
  });
});

test('junk in a window parameter is ignored rather than emptying the view', async () => {
  // "no bound" is the safe reading of nonsense. Treating it as 0 would show
  // nothing and look like an empty database.
  await withApp(async (app) => {
    seed(app);
    for (const path of ANALYTICS) {
      const junk = await (await fetch(`${app.origin}${path}?since=not-a-date`)).json();
      const none = await (await fetch(`${app.origin}${path}`)).json();
      assert.deepEqual(junk, none, `${path} did not ignore an unparseable window`);
    }
  });
});

test('the seeded call shows up in all four views', async () => {
  // One call that costs money, errors, uses a tool, and contains a word —
  // every view should be able to see it.
  await withApp(async (app) => {
    seed(app);

    assert.equal((await (await fetch(`${app.origin}/api/spend`)).json()).total_calls, 1);
    assert.equal((await (await fetch(`${app.origin}/api/tools`)).json()).total_uses, 1);
    assert.equal((await (await fetch(`${app.origin}/api/errors`)).json()).total_errors, 1);
    assert.equal((await (await fetch(`${app.origin}/api/search?q=needle`)).json()).total, 1);
  });
});
