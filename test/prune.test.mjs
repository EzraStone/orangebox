// §09 — keeping the database from growing forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, newId } from '../src/store.mjs';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-prune-'));
  const store = new Store(path.join(dir, 'p.db'));
  return { store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Runs of bulky calls, oldest first, so pruning has something to reclaim. */
function fill(store, runCount, callsPerRun = 12) {
  const filler = 'x'.repeat(4000);
  for (let r = 0; r < runCount; r++) {
    const run = store.createRun({
      name: `run ${r}`,
      source: 'gap',
      started_at: 1_000_000 + r * 86_400_000
    });
    store.db.transaction(() => {
      for (let c = 0; c < callsPerRun; c++) {
        store.insertCall({
          id: newId(), run_id: run.id, seq: store.nextSeq(run.id),
          provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
          started_at: 1_000_000 + r * 86_400_000 + c,
          request_json: JSON.stringify({ filler }),
          response_json: JSON.stringify({ filler })
        });
      }
    })();
  }
}

test('vacuum returns deleted pages to the filesystem', () => {
  // SQLite frees pages for reuse on delete but does not shrink the file. Without
  // an explicit VACUUM a prune reports success while the file stays the size it
  // was, which is exactly the complaint pruning exists to answer.
  const { store, cleanup } = tempStore();
  try {
    fill(store, 8);
    const full = store.sizeBytes();

    store.clearAll();
    const afterDelete = store.checkpoint();
    store.vacuum();
    const afterVacuum = store.sizeBytes();

    assert.ok(afterVacuum < full, `vacuum did not shrink the file: ${full} -> ${afterVacuum}`);
    assert.ok(afterVacuum <= afterDelete, 'vacuum should not grow the file');
  } finally {
    store.close();
    cleanup();
  }
});

test('pruning to a size deletes oldest first and stops', () => {
  const { store, cleanup } = tempStore();
  try {
    fill(store, 10);
    const before = store.sizeBytes();
    const target = Math.floor(before / 2);

    const result = store.pruneToSize(target);

    assert.ok(result.deleted > 0, 'nothing was deleted');
    assert.ok(result.after < before, `file did not shrink: ${before} -> ${result.after}`);
    assert.equal(result.before, before);

    // Whatever survived must be the newest, because age is the only ordering
    // anyone can reason about.
    const remaining = store.listRuns().runs.map((r) => r.name);
    assert.ok(remaining.includes('run 9'), 'the newest run was deleted');
    assert.ok(!remaining.includes('run 0'), 'the oldest run survived');
  } finally {
    store.close();
    cleanup();
  }
});

test('a database already under the target is left alone', () => {
  const { store, cleanup } = tempStore();
  try {
    fill(store, 2);
    const before = store.sizeBytes();
    const result = store.pruneToSize(before * 10);

    assert.equal(result.deleted, 0);
    assert.equal(result.reclaimed, 0);
    assert.equal(store.countRuns(), 2, 'nothing was removed');
  } finally {
    store.close();
    cleanup();
  }
});

test('pruning never removes the last run', () => {
  // A tool that empties itself to hit a size target looks like it lost your
  // data, whatever the target said.
  const { store, cleanup } = tempStore();
  try {
    fill(store, 4);
    store.pruneToSize(1); // impossible target
    assert.equal(store.countRuns(), 1, 'the newest run must survive any target');
  } finally {
    store.close();
    cleanup();
  }
});

test('a nonsensical target is refused rather than obeyed', () => {
  const { store, cleanup } = tempStore();
  try {
    fill(store, 3);
    for (const target of [0, -1, NaN, undefined, null]) {
      const result = store.pruneToSize(target);
      assert.equal(result.deleted, 0, `target ${target} deleted something`);
    }
    assert.equal(store.countRuns(), 3);
  } finally {
    store.close();
    cleanup();
  }
});

test('an in-memory store reports zero rather than failing', () => {
  const store = new Store(':memory:');
  assert.equal(store.vacuum(), 0);
  assert.equal(store.checkpoint(), 0);
  assert.deepEqual(store.pruneToSize(100), { deleted: 0, before: 0, after: 0, reclaimed: 0 });
  store.close();
});
