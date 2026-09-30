// The test harness cleans up after itself.
//
// It did not. Every test that started a recorder left a directory in the OS
// temp folder, and six and a half thousand of them had piled up before anyone
// noticed — each holding a SQLite file with its -wal and -shm beside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startOrangebox, startCliServer, removeTempDir, tempDirOf } from './helpers.mjs';

test('stopping an in-process recorder removes its directory', async () => {
  const app = await startOrangebox({});
  const dir = path.dirname(app.dbPath);
  assert.ok(fs.existsSync(dir));
  await app.stop();
  assert.equal(fs.existsSync(dir), false);
});

test('stopping a CLI recorder removes its directory', async () => {
  const server = await startCliServer();
  assert.ok(fs.existsSync(server.dir));
  await server.stop();
  assert.equal(fs.existsSync(server.dir), false, 'the CLI server left its database directory behind');
});

test('handing removeTempDir a database file removes the directory it lives in', async () => {
  // Fifty-seven call sites did exactly this.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-test-'));
  const db = path.join(dir, 'test.db');
  for (const suffix of ['', '-wal', '-shm']) fs.writeFileSync(db + suffix, 'x');

  await removeTempDir(db);
  assert.equal(fs.existsSync(dir), false);
});

test('a path that is not one of ours is never widened', () => {
  // The resolution only ever climbs out of this suite's own temp directories.
  const elsewhere = path.join(os.tmpdir(), 'someone-else', 'data.db');
  assert.equal(tempDirOf(elsewhere), elsewhere);

  const nested = path.join(os.tmpdir(), 'orangebox-test-abc', 'deeper', 'x.db');
  assert.equal(tempDirOf(nested), nested, 'only a direct child of our temp dir is resolved');
});
