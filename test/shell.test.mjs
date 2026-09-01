// §11 — the offline app shell.
//
// The failure this guards against is quiet: the page loads from cache, then
// dies on an import that was never cached, and the user sees "Recorder
// unavailable" while the server is running perfectly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (name) => fs.readFileSync(new URL(`../ui/${name}`, import.meta.url), 'utf8');

/** The SHELL array from the service worker, as a list of paths. */
function shellPaths() {
  const source = read('service-worker.js');
  const start = source.indexOf('const SHELL = [');
  const end = source.indexOf('];', start);
  assert.ok(start >= 0 && end > start, 'could not find the SHELL array');
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('every module app.js imports is in the offline shell', () => {
  const imports = [...read('app.js').matchAll(/from '(\/[^']+\.js)'/g)].map((m) => m[1]);
  assert.ok(imports.length >= 5, `only found ${imports.length} imports to check`);

  const shell = new Set(shellPaths());
  for (const path of imports) {
    assert.ok(shell.has(path), `${path} is imported but not precached — offline loads will fail on it`);
  }
});

test('every module the view modules import is in the shell too', () => {
  // The views import dom.js. A second-level import missing from the shell
  // fails in exactly the same way as a first-level one.
  const shell = new Set(shellPaths());
  for (const view of ['spend.js', 'tools.js', 'find.js', 'errors.js']) {
    const imports = [...read(view).matchAll(/from '\.\/([^']+\.js)'/g)].map((m) => `/${m[1]}`);
    for (const path of imports) {
      assert.ok(shell.has(path), `${view} imports ${path}, which is not precached`);
    }
  }
});

test('the shell lists nothing that does not exist', () => {
  // A 404 in the precache list makes cache.addAll reject, which silently
  // disables the whole offline shell rather than just that one file.
  for (const path of shellPaths()) {
    if (path === '/') continue; // the app route, served as index.html
    const name = path.replace(/^\//, '');
    assert.ok(
      fs.existsSync(new URL(`../ui/${name}`, import.meta.url)),
      `${path} is precached but does not exist in ui/`
    );
  }
});

test('the cache name changes when the shell does', () => {
  // Bumping the version is what evicts the old shell. Forgetting leaves users
  // on a cached app.js that imports a module their cache has never heard of.
  const source = read('service-worker.js');
  const match = source.match(/const CACHE = 'orangebox-shell-v(\d+)'/);
  assert.ok(match, 'the cache name must carry a version');
  assert.ok(Number(match[1]) >= 5, `cache version looks stale at v${match[1]}`);
});

test('the shell never caches recorded data', () => {
  // The whole database is prompts. An offline shell that cached /api would put
  // them in the browser cache, which is not where anyone expects to find them.
  for (const path of shellPaths()) {
    assert.ok(!path.startsWith('/api'), `${path} would cache recorded data`);
    assert.ok(!path.startsWith('/run/'), `${path} would cache a recorded run`);
  }
});
