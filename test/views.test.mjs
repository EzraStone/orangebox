// A view in the UI has to be registered in nine places, and adding the
// diagnosis view meant finding all nine by hand. This derives them from the
// one list that has to exist anyway — the `*_PATH` constants in app.js — so the
// next view either appears everywhere or fails here, naming where it is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const app = read('ui/app.js');
const server = read('src/server.mjs');

/** Every view, as { name: 'Diagnosis', path: '/diagnosis' }. */
const views = [...app.matchAll(/const ([A-Z]+)_PATH = '(\/[a-z]+)'/g)].map(([, name, path]) => ({
  name: name[0] + name.slice(1).toLowerCase(),
  path
}));

test('the view list is what it should be', () => {
  assert.ok(views.length >= 5, `only found ${views.length} views`);
  assert.ok(views.some((v) => v.path === '/diagnosis'));
});

for (const { name, path } of views) {
  test(`${path} is registered everywhere a view has to be`, () => {
    // A reload or a pasted link arrives at the server as a plain GET.
    assert.ok(server.includes(`pathname === '${path}'`), `the server does not serve the shell at ${path}`);

    // Back and forward arrive as popstate, not as a click.
    const popstate = app.slice(app.indexOf("window.addEventListener('popstate'"));
    assert.ok(popstate.slice(0, 900).includes(`pathIs${name}()`), `popstate does not restore ${path}`);

    // Opening the app at the path arrives through boot, before anything is loaded.
    assert.ok(app.includes(`const boot${name} = pathIs${name}();`), `boot does not remember ${path}`);
    assert.ok(app.includes(`if (boot${name}) await open${name}(`), `boot does not open ${path}`);

    // And there has to be a way to get there at all.
    assert.ok(app.includes(`async function open${name}(`), `nothing opens ${path}`);
  });
}

test('a diagnosis finding that names a call opens that call, not just its run', () => {
  // Checked by hand in a browser when it was added; this keeps both ends of
  // the wire joined. The view hands over the finding's call, and the app opens
  // it when one is given — falling back to the run when it is not.
  const view = read('ui/diagnosis.js');
  assert.match(view, /onOpen\(entry, finding\.call_id\)/, 'the button no longer passes the call');

  const start = app.indexOf("renderDiagnosis($('timeline')");
  assert.ok(start >= 0, 'the diagnosis view is no longer rendered from renderTimeline');
  const handler = app.slice(start, app.indexOf("if (state.view === 'errors')", start));
  assert.match(handler, /\(entry, callId\) =>/);
  assert.match(handler, /if \(callId\) return void openCallById\(callId\);/, 'a call id is ignored');
  assert.match(handler, /navigate\(entry\.run\.id\)/, 'no fallback to the run');
});
