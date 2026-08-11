// §09 / §12.2 / §14.2 — schema, transactions, redaction, truncation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  Store,
  redactHeaders,
  stripBase64,
  serializeForStorage,
  autoRunName,
  newId,
  MAX_BLOB_BYTES
} from '../src/store.mjs';

function memStore() {
  return new Store(':memory:');
}

function call(store, runId, overrides = {}) {
  return {
    id: newId(),
    run_id: runId,
    seq: store.nextSeq(runId),
    provider: 'anthropic',
    endpoint: '/v1/messages',
    started_at: Date.now(),
    request_json: '{}',
    ...overrides
  };
}

test('schema bootstraps and records its version', () => {
  const store = memStore();
  const version = store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(version.value, '2');

  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const expected of ['calls', 'meta', 'runs', 'tool_events']) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
  store.close();
});

test('schema 1 databases migrate in place without losing runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-migration-'));
  const file = path.join(dir, 'v1.db');
  const legacy = new Database(file);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('schema_version', '1');
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, name TEXT, source TEXT NOT NULL, started_at INTEGER NOT NULL,
      ended_at INTEGER, call_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO runs (id, name, source, started_at) VALUES ('legacy-run', 'Legacy', 'explicit', 1);
  `);
  legacy.close();

  const store = new Store(file);
  assert.equal(store.getRun('legacy-run').name, 'Legacy');
  assert.equal(store.getRun('legacy-run').unknown_cost_count, 0);
  assert.deepEqual(store.getRun('legacy-run').tags, []);
  assert.equal(
    store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
    '2'
  );
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('run aggregates are maintained incrementally, never rescanned', () => {
  const store = memStore();
  const run = store.createRun({ source: 'gap', name: 'agg' });

  store.insertCall(call(store, run.id, { input_tokens: 10, output_tokens: 4, cost_usd: 0.01 }));
  store.insertCall(call(store, run.id, { input_tokens: 5, output_tokens: 2, cost_usd: 0.02 }));
  store.insertCall(call(store, run.id, { error_type: 'http_429', status: 429 }));

  const after = store.getRun(run.id);
  assert.equal(after.call_count, 3);
  assert.equal(after.input_tokens, 15);
  assert.equal(after.output_tokens, 6);
  assert.ok(Math.abs(after.cost_usd - 0.03) < 1e-9);
  assert.equal(after.error_count, 1);

  assert.deepEqual(store.callSummaries(run.id).map((c) => c.seq), [1, 2, 3]);
  store.close();
});

test('a failing tool-event insert rolls the whole call back (§09 one transaction)', () => {
  const store = memStore();
  const run = store.createRun({ source: 'gap' });
  const row = call(store, run.id);

  assert.throws(() =>
    store.insertCall(row, [
      { id: newId(), run_id: run.id, call_id: row.id, kind: 'not_a_valid_kind', content_json: null }
    ])
  );

  assert.equal(store.callSummaries(run.id).length, 0, 'call row rolled back');
  assert.equal(store.getRun(run.id).call_count, 0, 'aggregate rolled back');
  store.close();
});

test('deleting a run cascades to its calls and tool events', () => {
  const store = memStore();
  const run = store.createRun({ source: 'gap' });
  const row = call(store, run.id);
  store.insertCall(row, [
    {
      id: newId(),
      run_id: run.id,
      call_id: row.id,
      kind: 'tool_use',
      tool_name: 'search',
      tool_use_id: 'toolu_1',
      is_error: 0,
      content_json: '{}'
    }
  ]);

  assert.equal(store.toolEvents(run.id).length, 1);
  store.deleteRun(run.id);
  assert.equal(store.callSummaries(run.id).length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tool_events').get().n, 0);
  store.close();
});

test('resolveRun honours path, header, then the idle gap (§06.4)', () => {
  const store = memStore();
  const now = Date.now();

  const explicit = store.resolveRun({ explicitRunId: 'run-a', gapSeconds: 120, now });
  assert.equal(explicit.created, true);
  assert.equal(explicit.run.source, 'explicit');

  const header = store.resolveRun({ headerRunId: 'run-b', gapSeconds: 120, now });
  assert.equal(header.run.source, 'header');

  const first = store.resolveRun({ gapSeconds: 120, now });
  assert.equal(first.run.source, 'gap');
  store.insertCall(call(store, first.run.id, { started_at: now, ended_at: now }));

  // Inside the window: same run.
  const same = store.resolveRun({ gapSeconds: 120, now: now + 60_000 });
  assert.equal(same.run.id, first.run.id);
  assert.equal(same.created, false);

  // Past the window: new run, and the old one is closed out lazily.
  const next = store.resolveRun({ gapSeconds: 120, now: now + 200_000 });
  assert.notEqual(next.run.id, first.run.id);
  assert.equal(store.getRun(first.run.id).ended_at, now);
  store.close();
});

test('retention deletes only runs older than the cutoff', () => {
  const store = memStore();
  const old = store.createRun({ source: 'gap', started_at: Date.now() - 10 * 86400_000 });
  const fresh = store.createRun({ source: 'gap', started_at: Date.now() });

  assert.equal(store.retain(7), 1);
  assert.equal(store.getRun(old.id), null);
  assert.ok(store.getRun(fresh.id));
  assert.equal(store.retain(0), 0, 'zero means keep forever');
  store.close();
});

test('header redaction is an allowlist, and credentials never survive it (§12.2)', () => {
  const out = redactHeaders({
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'User-Agent': 'anthropic-sdk-python/0.40.0',
    'x-api-key': 'sk-ant-secret',
    authorization: 'Bearer sk-secret',
    cookie: 'session=abc',
    'x-custom-thing': 'whatever'
  });

  assert.deepEqual(out, {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'user-agent': 'anthropic-sdk-python/0.40.0'
  });
});

test('base64 images and documents are swapped for a size note (§14.2)', () => {
  const big = 'A'.repeat(200_000);
  const payload = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } },
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${big}` } }
        ]
      }
    ]
  };

  const cleaned = stripBase64(structuredClone(payload));
  const blocks = cleaned.messages[0].content;
  assert.match(blocks[0].source.data, /^\[orangebox: base64 image\/png, \d+ KB removed\]$/);
  assert.equal(blocks[1].text, 'what is this?', 'ordinary text is untouched');
  assert.match(blocks[2].image_url.url, /^\[orangebox: base64 image\/jpeg, \d+ KB removed\]$/);
  assert.equal(payload.messages[0].content[0].source.data.length, 200_000, 'input not mutated');
});

test('oversized payloads keep their structure and lose only bulk text (§14.2)', () => {
  const payload = {
    model: 'claude-opus-5',
    messages: [
      { role: 'user', content: 'X'.repeat(3 * 1024 * 1024) },
      { role: 'assistant', content: 'short' }
    ]
  };

  const { json, truncated } = serializeForStorage(payload);
  assert.equal(truncated, 1);
  assert.ok(Buffer.byteLength(json) <= MAX_BLOB_BYTES);

  const back = JSON.parse(json);
  assert.equal(back.model, 'claude-opus-5', 'small leaves survive intact');
  assert.equal(back.messages[1].content, 'short');
  assert.match(back.messages[0].content, /…\[orangebox: truncated \d+ bytes\]$/);
});

test('payloads under the cap are stored untouched', () => {
  const payload = { hello: 'world', nested: { n: 1 } };
  const { json, truncated } = serializeForStorage(payload);
  assert.equal(truncated, 0);
  assert.deepEqual(JSON.parse(json), payload);
});

test('ids sort chronologically and auto run names read as timestamps', async () => {
  const a = newId();
  await new Promise((r) => setTimeout(r, 2));
  const b = newId();
  assert.ok(a < b, `${a} should sort before ${b}`);
  assert.match(autoRunName(new Date('2026-07-27T14:03:00').getTime()), /^run 2026-07-27 \d{2}:03$/);
});
