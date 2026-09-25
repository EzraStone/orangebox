// §19.7 — telling the user a replay key is missing before they press Replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * missingKeyHint lives in app.js, which cannot be imported in node — it touches
 * document at module scope. The function is small and pure, so it is lifted out
 * of the source and evaluated here rather than duplicated into a test fixture,
 * which would drift.
 */
function loadHint() {
  const source = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function missingKeyHint(');
  assert.ok(start >= 0, 'missingKeyHint not found in app.js');
  const end = source.indexOf('\n}', start) + 2;
  const body = source.slice(start, end).replace('export function', 'function');
  return new Function(`${body}; return missingKeyHint;`)();
}

const missingKeyHint = loadHint();

test('a provider with its key present needs no hint', () => {
  assert.equal(
    missingKeyHint({ provider: 'anthropic', enforced: true, available: true, checked: ['ANTHROPIC_API_KEY'] }),
    null
  );
});

test('a missing key names the variables to set', () => {
  const hint = missingKeyHint({
    provider: 'gemini', enforced: true, available: false,
    checked: ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
  });
  assert.match(hint, /GEMINI_API_KEY or GOOGLE_API_KEY/);
  assert.match(hint, /environment orangebox runs in/);
});

test('one variable reads as one variable, not a list of one', () => {
  const hint = missingKeyHint({
    provider: 'openai', enforced: true, available: false, checked: ['OPENAI_API_KEY']
  });
  assert.match(hint, /needs OPENAI_API_KEY in/);
  assert.doesNotMatch(hint, / or /);
});

test('a provider pointed at a local gateway is never marked', () => {
  // Someone running vLLM needs no key. Marking the button there would be
  // telling them something untrue about their own setup.
  assert.equal(
    missingKeyHint({ provider: 'anthropic', enforced: false, available: false, checked: ['ANTHROPIC_API_KEY'] }),
    null
  );
});

test('a provider that needs no key at all is never marked', () => {
  assert.equal(
    missingKeyHint({ provider: 'ollama', enforced: false, available: true, checked: [] }),
    null
  );
  assert.equal(
    missingKeyHint({ provider: 'ollama', enforced: true, available: false, checked: [] }),
    null,
    'nothing to name means nothing useful to say'
  );
});

test('an unknown provider produces no hint rather than a broken one', () => {
  assert.equal(missingKeyHint(null), null);
  assert.equal(missingKeyHint(undefined), null);
});
