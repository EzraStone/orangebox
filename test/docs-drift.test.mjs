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

/**
 * Every API route the server answers, written the way the README writes them.
 *
 * Two shapes in server.mjs: a literal `pathname === '/api/...'`, and segment
 * checks for the routes with an id in the middle.
 */
function servedRoutes() {
  const source = read('src/server.mjs');
  const routes = new Set();

  for (const [, method, path] of source.matchAll(/method === '([A-Z]+)' && pathname === '(\/api[^']*)'/g)) {
    routes.add(`${method} ${path}`);
  }
  for (const [, method, one, two, three] of source.matchAll(
    /method === '([A-Z]+)' && seg\.length === \d+ && seg\[1\] === '([a-z.]+)'(?: && seg\[2\] === '([a-z.]+)')?(?: && seg\[3\] === '([a-z.]+)')?/g
  )) {
    // seg[2] is a literal segment when it is checked, and the id when it is not.
    const middle = two ? `${two}/:id` : ':id';
    routes.add(`${method} /api/${one}/${middle}${three ? `/${three}` : ''}`);
  }
  return [...routes];
}

test('every API route the server answers is in the README', () => {
  const readme = read('README.md');
  const routes = servedRoutes();
  assert.ok(routes.length >= 15, `only found ${routes.length} routes to check`);

  const missing = routes.filter((route) => {
    const [method, path] = route.split(' ');
    return !readme.includes(`\`${method} ${path}\``);
  });
  assert.deepEqual(missing, [], `undocumented: ${missing.join(', ')}`);
});

test('the README does not document routes the server does not answer', () => {
  // The direction that rots quietly: a route removed, its row left behind.
  const readme = read('README.md');
  const source = read('src/server.mjs');
  const documented = [...readme.matchAll(/`(?:GET|POST|PUT|DELETE) (\/api\/[^`]*)`/g)].map((m) => m[1]);
  assert.ok(documented.length >= 15, `only found ${documented.length} documented routes`);

  for (const path of documented) {
    if (!path.includes(':id')) {
      assert.ok(source.includes(`'${path}'`), `the README documents ${path}, which the server does not answer`);
      continue;
    }
    // e.g. /api/runs/:id/loops is served as seg[1] === 'runs' && seg[3] === 'loops'.
    const parts = path.split('/').slice(2); // drop the leading '' and 'api'
    const literals = parts.filter((part) => part !== ':id');
    for (const literal of literals) {
      assert.ok(
        source.includes(`'${literal}'`),
        `the README documents ${path}, and the server never mentions "${literal}"`
      );
    }
  }
});
