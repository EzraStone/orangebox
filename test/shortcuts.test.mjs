// §11 — the keyboard shortcut list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SHORTCUTS } from '../ui/dom.js';

const APP = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');

/** How the key appears inside a comparison in app.js source. */
function bindingFor(key) {
  const BS = String.fromCharCode(92);
  // A backslash key is written escaped in the source it is compared against.
  const literal = key === BS ? BS + BS : key;
  return "e.key === '" + literal + "'";
}

test('every documented shortcut is actually bound in the app', () => {
  // The list is written by hand and the bindings live elsewhere, so they drift.
  // A shortcut nobody knows about is bad; one documented but not implemented is
  // worse, because the user concludes the app is broken rather than that they
  // misremembered it.
  const byName = { Esc: 'Escape' };

  for (const shortcut of SHORTCUTS) {
    for (const key of shortcut.keys) {
      const needle = bindingFor(byName[key] ?? key);
      assert.ok(APP.includes(needle), `"${key}" is documented but not bound (looked for ${needle})`);
    }
  }
});

test('the list has no duplicate keys', () => {
  const keys = SHORTCUTS.flatMap((s) => s.keys);
  assert.equal(new Set(keys).size, keys.length, `duplicate binding in ${keys.join(', ')}`);
});

test('every entry says what it does', () => {
  for (const shortcut of SHORTCUTS) {
    assert.ok(shortcut.keys.length > 0, 'a shortcut with no key');
    assert.ok(shortcut.label && shortcut.label.length > 3, `unhelpful label: ${shortcut.label}`);
  }
});

test('the help overlay is itself reachable by keyboard', () => {
  assert.ok(SHORTCUTS.some((s) => s.keys.includes('?')), '? must be listed');
  assert.ok(APP.includes('openShortcutHelp'), 'and wired to something');
});

test('the shared time windows are used, not redefined per view', async () => {
  // Three views each defined their own list and had already drifted — spend
  // said "24 hours" where tools said "Last 24 hours", for no reason anyone
  // chose. One list means that cannot happen again.
  const { WINDOWS } = await import('../ui/dom.js');
  assert.ok(WINDOWS.length >= 3);
  assert.deepEqual(WINDOWS[0], ['', 'All time'], 'the default window is all of it');

  const fsMod = await import('node:fs');
  for (const view of ['spend.js', 'tools.js', 'errors.js']) {
    const source = fsMod.readFileSync(new URL(`../ui/${view}`, import.meta.url), 'utf8');
    assert.ok(!source.includes('const WINDOWS = ['), `${view} redefines WINDOWS`);
    assert.ok(!source.includes('function segmented('), `${view} redefines segmented()`);
    assert.match(source, /from '\.\/dom\.js'/, `${view} does not import the shared helpers`);
  }
});
