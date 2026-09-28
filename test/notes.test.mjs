// §24 — notes on runs and calls, and the schema migration that adds them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Store, newId, normaliseNote, SCHEMA_VERSION } from '../src/store.mjs';
import { removeTempDir } from './helpers.mjs';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-notes-'));
  // removeTempDir retries: Windows can hold a handle a moment after close.
  return { file: path.join(dir, 'n.db'), cleanup: () => removeTempDir(dir) };
}

test('a note can be set, replaced and cleared', () => {
  // Replaced rather than appended: a debugging note is a conclusion, and a
  // growing list of half-thoughts is worse than one sentence you keep fixing.
  const store = new Store(':memory:');
  const run = store.createRun({ name: 'demo', source: 'gap' });

  assert.equal(store.setRunNote(run.id, 'first').note, 'first');
  assert.equal(store.setRunNote(run.id, 'second').note, 'second');
  assert.equal(store.getRun(run.id).note, 'second');

  // An empty note clears it, so there is no separate delete to remember.
  assert.equal(store.setRunNote(run.id, '   ').note, null);
  assert.equal(store.getRun(run.id).note, null);
  store.close();
});

test('a note on a missing run or call reports that, rather than silently doing nothing', () => {
  const store = new Store(':memory:');
  assert.equal(store.setRunNote('no-such-run', 'x'), null);
  assert.equal(store.setCallNote('no-such-call', 'x'), null);
  store.close();
});

test('notes are trimmed and capped', () => {
  assert.equal(normaliseNote('  padded  '), 'padded');
  assert.equal(normaliseNote(''), null);
  assert.equal(normaliseNote('   '), null);
  assert.equal(normaliseNote(null), null);
  assert.equal(normaliseNote(undefined), null);
  assert.equal(normaliseNote('x'.repeat(5000)).length, 2000, 'capped, not rejected');
  assert.equal(normaliseNote(42), '42', 'anything stringable is a note');
});

test('every note is listed newest first, across runs and calls', () => {
  const store = new Store(':memory:');
  const run = store.createRun({ name: 'the run', source: 'gap', started_at: 1_000_000 });
  const callId = newId();
  store.insertCall({
    id: callId, run_id: run.id, seq: 1,
    provider: 'anthropic', endpoint: '/v1/messages',
    started_at: 2_000_000, request_json: '{}'
  });

  store.setRunNote(run.id, 'whole run was a retry storm');
  store.setCallNote(callId, 'this is the call that returned nothing');

  const { notes } = store.notes();
  assert.equal(notes.length, 2);
  assert.equal(notes[0].kind, 'call', 'newest first');
  assert.equal(notes[0].run_name, 'the run', 'a call note carries its run');
  assert.equal(notes[0].seq, 1);
  assert.equal(notes[1].kind, 'run');
  assert.equal(notes[1].seq, null);
  store.close();
});

test('cleared notes drop out of the list', () => {
  const store = new Store(':memory:');
  const run = store.createRun({ source: 'gap' });
  store.setRunNote(run.id, 'temporary');
  assert.equal(store.notes().total, 1);
  store.setRunNote(run.id, '');
  assert.equal(store.notes().total, 0);
  store.close();
});

test('a schema 2 database is migrated in place, keeping its data (§09)', () => {
  // The migration that matters: someone upgrading orangebox must not lose
  // recordings, and must not have to know a migration happened.
  const { file, cleanup } = tempFile();
  try {
    // Build a v2 database by hand: the schema as it was, plus a run.
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, name TEXT, source TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER,
        call_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        unknown_cost_count INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE calls (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
        provider TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT, status INTEGER,
        error_type TEXT, streamed INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL, first_token_at INTEGER, ended_at INTEGER,
        latency_ms INTEGER, ttft_ms INTEGER,
        input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        stop_reason TEXT, cost_usd REAL,
        request_json TEXT NOT NULL, response_json TEXT,
        truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE tool_events (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, call_id TEXT NOT NULL,
        kind TEXT NOT NULL, tool_name TEXT, tool_use_id TEXT,
        is_error INTEGER NOT NULL DEFAULT 0, content_json TEXT
      );
      INSERT INTO meta VALUES ('schema_version', '2');
      INSERT INTO runs (id, name, source, started_at) VALUES ('old-run', 'from v2', 'gap', 1000);
    `);
    raw.close();

    // Opening it with the current store should migrate it.
    const store = new Store(file);
    assert.equal(
      store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
      SCHEMA_VERSION
    );

    const run = store.getRun('old-run');
    assert.ok(run, 'the existing run survived the migration');
    assert.equal(run.name, 'from v2');
    assert.equal(run.note, null, 'and gained the new column');

    assert.equal(store.setRunNote('old-run', 'noted after upgrading').note, 'noted after upgrading');
    store.close();
  } finally {
    cleanup();
  }
});

test('a database from a newer orangebox is refused rather than corrupted', () => {
  const { file, cleanup } = tempFile();
  try {
    const raw = new Database(file);
    raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '99');");
    raw.close();
    assert.throws(() => new Store(file), /newer than this orangebox supports/);
  } finally {
    cleanup();
  }
});

test('a migration can run twice without failing (§09)', () => {
  // The schema is applied with CREATE TABLE IF NOT EXISTS before migrations,
  // so a table that did not exist is created at the current shape — and a
  // migration that then ALTERs it would hit "duplicate column name". Opening a
  // schema 1 database, which has runs but no calls table, did exactly that.
  const { file, cleanup } = tempFile();
  try {
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, name TEXT, source TEXT NOT NULL, started_at INTEGER NOT NULL,
        ended_at INTEGER, call_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO meta VALUES ('schema_version', '1');
      INSERT INTO runs (id, name, source, started_at) VALUES ('ancient', 'from v1', 'explicit', 1);
    `);
    raw.close();

    // v1 -> v2 -> v3 in one open, with calls created fresh in between.
    const store = new Store(file);
    assert.equal(store.getRun('ancient').name, 'from v1');
    assert.equal(store.getRun('ancient').note, null);
    assert.equal(
      store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
      SCHEMA_VERSION
    );

    // And the note column is usable on both tables afterwards.
    assert.equal(store.setRunNote('ancient', 'still here').note, 'still here');
    store.close();

    // Re-opening an already-migrated database must be a no-op.
    const again = new Store(file);
    assert.equal(again.getRun('ancient').note, 'still here');
    again.close();
  } finally {
    cleanup();
  }
});
