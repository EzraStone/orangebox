// The README is a list of what orangebox does, kept beside another list of what
// orangebox does. That is this codebase's recurring failure — routes and
// upstreams, providers and env vars, help text and dispatch — so the README
// gets the same treatment as the rest: a test, not a habit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

/** The commands `main()` actually dispatches, less the two nobody documents. */
function dispatchedCommands() {
  const source = read('src/cli.mjs');
  const start = source.indexOf('export async function main(');
  const end = source.indexOf('}', source.indexOf('default:', start));
  return [...source.slice(start, end).matchAll(/case '([a-z-]+)':/g)]
    .map((m) => m[1])
    .filter((name) => !['help', 'version'].includes(name));
}

test('every command the CLI dispatches is in the README', () => {
  const readme = read('README.md');
  const commands = dispatchedCommands();
  assert.ok(commands.length >= 14, `only found ${commands.length} commands to check`);

  for (const command of commands) {
    assert.ok(
      readme.includes(`\`orangebox ${command}`),
      `"${command}" is dispatched but never documented in README.md`
    );
  }
});

test('every assert threshold the CLI accepts is in the README', () => {
  // A CI gate nobody can find is a CI gate nobody adds, which is the whole
  // reason for having written it.
  const source = read('src/cli.mjs');
  const readme = read('README.md');

  const start = source.indexOf('async function assertRun(');
  const end = source.indexOf('const runId = positional[0]', start);
  const flags = [...source.slice(start, end).matchAll(/case '(--[a-z-]+)':/g)]
    .map((m) => m[1])
    .filter((flag) => !['--db', '--json'].includes(flag));

  assert.ok(flags.length >= 7, `only found ${flags.length} thresholds to check`);
  for (const flag of flags) {
    assert.ok(readme.includes(flag), `"${flag}" is accepted but never documented in README.md`);
  }
});

test('every start flag the CLI accepts is in the README', () => {
  const source = read('src/cli.mjs');
  const readme = read('README.md');

  const start = source.indexOf('function parseFlags(');
  const end = source.indexOf("case '--help':", start);
  const flags = [...source.slice(start, end).matchAll(/case '(--[a-z-]+)':/g)].map((m) => m[1]);

  assert.ok(flags.length >= 12, `only found ${flags.length} flags to check`);
  for (const flag of flags) {
    assert.ok(readme.includes(flag), `"${flag}" is accepted but never documented in README.md`);
  }
});

test('the changelog has somewhere to put the next change', () => {
  // A release with no Unreleased heading is a release where the next change
  // gets written into the last version's notes.
  assert.match(read('CHANGELOG.md'), /^## Unreleased$/m);
});
