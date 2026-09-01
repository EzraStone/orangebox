// §10.7 — reading an exported run back in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, newId } from '../src/store.mjs';
import { buildExport } from '../src/server.mjs';
import { importRun, parseExport, ImportError } from '../src/import.mjs';

/** A store holding one run with a tool call, and its export. */
function exported() {
  const store = new Store(':memory:');
  const run = store.createRun({ name: 'original run', source: 'explicit', started_at: 1_000_000 });
  const callId = newId();

  store.insertCall(
    {
      id: callId, run_id: run.id, seq: store.nextSeq(run.id),
      provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
      started_at: 1_000_000, ended_at: 1_001_000, latency_ms: 1000,
      input_tokens: 500, output_tokens: 40, cost_usd: 0.0035,
      stop_reason: 'tool_use',
      request_json: JSON.stringify({ messages: [{ role: 'user', content: 'why?' }] }),
      response_json: JSON.stringify({ content: [{ type: 'text', text: 'because' }] })
    },
    [{
      id: newId(), run_id: run.id, call_id: callId,
      kind: 'tool_use', tool_name: 'read_logs', tool_use_id: 'tu_1',
      is_error: 0, content_json: '{"service":"api"}'
    }]
  );
  store.endRun(run.id, 1_002_000);

  const payload = buildExport(store, run.id);
  store.close();
  return { payload, originalRunId: run.id, originalCallId: callId };
}

test('an exported run comes back whole', () => {
  const { payload } = exported();
  const store = new Store(':memory:');

  const result = importRun(store, payload);
  assert.equal(result.calls, 1);
  assert.equal(result.renamed, false, 'no collision in an empty store');

  const run = store.getRun(result.run_id);
  assert.match(run.name, /original run/);

  const [call] = store.fullCalls(result.run_id);
  assert.equal(call.model, 'claude-opus-5');
  assert.equal(call.input_tokens, 500);
  assert.equal(call.cost_usd, 0.0035);
  assert.equal(call.stop_reason, 'tool_use');
  assert.match(call.request_json, /why\?/);

  const tools = store.toolEvents(result.run_id);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool_name, 'read_logs');
  store.close();
});

test('an imported run is marked as imported', () => {
  // Otherwise a recording somebody else made is indistinguishable from your
  // own six weeks later, which is how you end up debugging the wrong machine.
  const { payload } = exported();
  const store = new Store(':memory:');
  const result = importRun(store, payload);
  assert.match(store.getRun(result.run_id).name, /\(imported\)/);
  store.close();
});

test('importing the same export twice keeps both, renaming the second', () => {
  // Overwriting would be worse: the person importing has no way to know what
  // they would be replacing.
  const { payload, originalRunId } = exported();
  const store = new Store(':memory:');

  const first = importRun(store, payload);
  const second = importRun(store, payload);

  assert.equal(first.run_id, originalRunId, 'the first keeps its id');
  assert.notEqual(second.run_id, first.run_id);
  assert.equal(second.renamed, true);
  assert.equal(store.countRuns(), 2);
  assert.equal(store.fullCalls(second.run_id).length, 1, 'the copy has its own calls');
  store.close();
});

test('tool events follow their calls when ids are rewritten', () => {
  // A tool event still pointing at the original call id would be dropped by
  // the foreign key, silently taking the tool timeline with it.
  const { payload } = exported();
  const store = new Store(':memory:');
  importRun(store, payload);
  const second = importRun(store, payload);

  const [call] = store.fullCalls(second.run_id);
  const tools = store.toolEvents(second.run_id);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].call_id, call.id, 'the tool event points at the new call id');
  store.close();
});

test('a file that is not an export is refused by name', () => {
  for (const [payload, expected] of [
    [null, /expected a JSON object/],
    ['a string', /expected a JSON object/],
    [{}, /no "orangebox_export" marker/],
    [{ orangebox_export: 1 }, /missing its run/],
    [{ orangebox_export: 1, run: { id: 'r' } }, /missing its calls/]
  ]) {
    assert.throws(() => parseExport(payload), ImportError, `accepted ${JSON.stringify(payload)}`);
    assert.throws(() => parseExport(payload), expected);
  }
});

test('an export with no tools imports fine', () => {
  const { payload } = exported();
  delete payload.tools;
  const store = new Store(':memory:');
  const result = importRun(store, payload);
  assert.equal(result.tools, 0);
  assert.equal(store.fullCalls(result.run_id).length, 1);
  store.close();
});

test('a failed import leaves nothing behind', () => {
  // The whole insert is one transaction, so a malformed call partway through
  // must not leave half a run in the database.
  const { payload } = exported();
  payload.calls.push({ id: 12345 }); // not a string id
  const store = new Store(':memory:');

  assert.throws(() => importRun(store, payload), ImportError);
  assert.equal(store.countRuns(), 0, 'a partial run survived a failed import');
  store.close();
});

test('a second import of the same file gets a distinguishable name', () => {
  // Two runs sharing a name collapse into a single row anywhere runs are
  // grouped by name — spend --group run, for one — so the copy has to be
  // tellable apart at a glance, not just by id.
  const { payload } = exported();
  const store = new Store(':memory:');

  const first = importRun(store, payload);
  const second = importRun(store, payload);

  const nameOf = (id) => store.getRun(id).name;
  assert.notEqual(nameOf(first.run_id), nameOf(second.run_id));
  assert.match(nameOf(second.run_id), /#2$/);

  const third = importRun(store, payload);
  assert.match(store.getRun(third.run_id).name, /#3$/);
  store.close();
});

test('POST /api/import loads a run and announces it live (§10.7)', async () => {
  const { startOrangebox, getJson, removeTempDir } = await import('./helpers.mjs');
  const app = await startOrangebox({});

  try {
    const { payload } = exported();
    const csrf = (await getJson(`${app.origin}/api/health`)).body.csrf_token;

    const res = await fetch(`${app.origin}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orangebox-csrf': csrf },
      body: JSON.stringify(payload)
    });

    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.calls, 1);

    const runs = (await getJson(`${app.origin}/api/runs`)).body.runs;
    assert.equal(runs.length, 1);
    assert.match(runs[0].name, /imported/);
  } finally {
    await app.close();
    removeTempDir(app.dbPath);
  }
});

test('a bad import is refused with what is wrong, not a bare 400', async () => {
  const { startOrangebox, getJson, removeTempDir } = await import('./helpers.mjs');
  const app = await startOrangebox({});

  try {
    const csrf = (await getJson(`${app.origin}/api/health`)).body.csrf_token;
    const post = (body) =>
      fetch(`${app.origin}/api/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orangebox-csrf': csrf },
        body
      });

    const notExport = await post(JSON.stringify({ hello: true }));
    assert.equal(notExport.status, 400);
    assert.match((await notExport.json()).error, /orangebox_export/);

    // "not JSON" and "too big" both used to be an indistinguishable null.
    const notJson = await post('{ definitely not json');
    assert.equal(notJson.status, 400);
    assert.match((await notJson.json()).error, /not valid JSON/);

    const empty = await post('');
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /empty request body/);
  } finally {
    await app.close();
    removeTempDir(app.dbPath);
  }
});

test('import is a mutation, so it needs the CSRF token', async () => {
  const { startOrangebox, removeTempDir } = await import('./helpers.mjs');
  const app = await startOrangebox({});

  try {
    const { payload } = exported();
    const res = await fetch(`${app.origin}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.equal(res.status, 403, 'import without a CSRF token must be refused');
    assert.equal(app.store.countRuns(), 0, 'and must not have inserted anything');
  } finally {
    await app.close();
    removeTempDir(app.dbPath);
  }
});
