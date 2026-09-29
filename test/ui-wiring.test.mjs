// The UI is JavaScript that reaches into HTML by id, with nothing checking the
// two agree. A renamed id is a TypeError at boot, and the page renders nothing
// at all — the same shape of failure as the detail pane, one level up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const file = (name) => fs.readFileSync(new URL(`../ui/${name}`, import.meta.url), 'utf8');
const shell = file('index.html');
const scripts = ['app.js', 'dom.js', 'spend.js', 'tools.js', 'errors.js', 'find.js', 'diff.js'];

/** Every id the shell defines. */
const declared = new Set([...shell.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

test('the shell declares the ids the scripts reach for', () => {
  const missing = [];
  for (const name of scripts) {
    for (const [, id] of file(name).matchAll(/\$\('([^']+)'\)/g)) {
      if (!declared.has(id)) missing.push(`${name} reaches for #${id}`);
    }
  }
  assert.deepEqual(missing, [], missing.join('; '));
});

test('every id in the shell is unique', () => {
  // Two elements with one id is a lookup that silently returns the wrong one.
  const ids = [...shell.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  const duplicated = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual(duplicated, [], `duplicated ids: ${duplicated.join(', ')}`);
});

test('every script the shell loads exists', () => {
  for (const [, src] of shell.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    assert.ok(
      fs.existsSync(new URL(`../ui/${src.replace(/^\//, '')}`, import.meta.url)),
      `index.html loads ${src}, which is not in ui/`
    );
  }
});

test('every module the scripts import exists', () => {
  // A second-level import is the one nobody checks, because the page loads
  // fine until the code path that needs it runs.
  for (const name of scripts) {
    for (const [, spec] of file(name).matchAll(/from '(\.[^']+)'/g)) {
      assert.ok(
        fs.existsSync(new URL(`../ui/${spec.replace(/^\.\//, '')}`, import.meta.url)),
        `${name} imports ${spec}, which does not exist`
      );
    }
  }
});

test('every ui script parses', async () => {
  // Cheap, and it is the check that would have caught a stray brace in a file
  // no test imports directly.
  //
  // fileURLToPath, not url.pathname: on Windows the pathname is "/C:/..." and
  // needs the slash removed, on POSIX removing it turns an absolute path into
  // a relative one. Doing it by hand passes on one and fails on the other.
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');

  for (const name of scripts) {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(`../ui/${name}`, import.meta.url))]);
  }
});
