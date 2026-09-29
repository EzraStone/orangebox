// The call detail pane, checked for the failure that took it out entirely.
//
// renderDetail() referenced `call` eighty lines above `const call = state.call`,
// which is a temporal dead zone: clicking any call in the timeline threw
// before the pane drew anything at all. Nothing caught it, because nothing
// here executes app.js against a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');

/** The source of one top-level function, by name. */
function bodyOf(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in app.js`);
  const end = app.indexOf('\n}', start);
  assert.ok(end > start, `could not find the end of ${name}`);
  return app.slice(start, end);
}

test('renderDetail declares every local before it reads it', () => {
  const body = bodyOf('renderDetail');
  for (const name of ['call', 'summary', 'head', 'tabs', 'panel']) {
    const declared = body.indexOf(`const ${name} =`);
    assert.ok(declared >= 0, `renderDetail no longer declares ${name}`);

    const used = body.search(new RegExp(`(?<![\w.'"\`$])${name}[.?]`));
    if (used === -1) continue;
    assert.ok(
      declared < used,
      `renderDetail reads ${name} at ${used} but declares it at ${declared} — that throws before anything renders`
    );
  }
});

test('the header draws from the call summary, which is there immediately', () => {
  // The full call is fetched separately and lands a moment later. Anything in
  // the header that waits for it is a header that flickers, or throws.
  const body = bodyOf('renderDetail');
  const header = body.slice(body.indexOf('head.append('), body.indexOf('for (const [id, label] of TABS)'));

  assert.match(header, /id: summary\.id/);
  assert.match(header, /current: summary\.note/);
  assert.equal(header.includes('id: call.id'), false);
});
