// §12.4 — user-defined redaction of recorded prompts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRedactionRules } from '../src/store.mjs';
import { compileRedactionRules } from '../src/config.mjs';

const compile = (patterns) => compileRedactionRules(
  patterns.map((p) => (typeof p === 'string' ? { pattern: p, replacement: '[redacted]', flags: 'g' } : p))
).rules;

test('a pattern is scrubbed from every string in the payload', () => {
  // A character class, deliberately free of backslashes: this file has lost
  // them in transit before, and a mangled pattern silently matches nothing.
  const rules = compile(['[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+[.][a-zA-Z]{2,}']);
  const { value } = applyRedactionRules(
    { messages: [{ role: 'user', content: 'email ada@example.com about it' }] },
    rules
  );
  assert.equal(value.messages[0].content, 'email [redacted] about it');
});

test('every occurrence goes, not just the first', () => {
  // A rule that scrubs the first instance of a secret has not scrubbed it.
  const rules = compile(['secret']);
  const { value } = applyRedactionRules({ a: 'secret and secret and secret' }, rules);
  assert.equal(value.a, '[redacted] and [redacted] and [redacted]');
});

test('a reused rule keeps working on the next payload', () => {
  // A /g regex remembers lastIndex between calls. Without resetting it, every
  // other recorded call would go unscrubbed — which is the kind of bug that
  // looks like it works when you test it once.
  const rules = compile(['token']);
  for (let i = 0; i < 5; i++) {
    const { value } = applyRedactionRules({ a: 'token here' }, rules);
    assert.equal(value.a, '[redacted] here', `call ${i} was not scrubbed`);
  }
});

test('object keys are left alone', () => {
  // Renaming a field changes the shape of the record. A prompt whose structure
  // silently changed is worse to debug than one with a visible placeholder.
  const rules = compile(['secret']);
  const { value } = applyRedactionRules({ secret: 'secret' }, rules);
  assert.deepEqual(Object.keys(value), ['secret']);
  assert.equal(value.secret, '[redacted]');
});

test('non-strings pass through untouched', () => {
  const rules = compile(['1']);
  const { value } = applyRedactionRules({ n: 1, b: true, z: null, arr: [1, 2] }, rules);
  assert.deepEqual(value, { n: 1, b: true, z: null, arr: [1, 2] });
});

test('hits are counted per rule so the UI can say it fired', () => {
  const rules = compileRedactionRules([
    { pattern: 'alpha', replacement: '[a]', flags: 'g', label: 'alphas' },
    { pattern: 'beta', replacement: '[b]', flags: 'g', label: 'betas' }
  ]).rules;

  const { hits } = applyRedactionRules({ x: 'alpha alpha beta' }, rules);
  assert.equal(hits.alphas, 2);
  assert.equal(hits.betas, 1);
});

test('no rules means the payload is returned unchanged, identically', () => {
  const payload = { messages: [{ content: 'anything at all' }] };
  const { value, hits } = applyRedactionRules(payload, []);
  assert.equal(value, payload, 'the same object, not a copy');
  assert.deepEqual(hits, {});
});

test('a pattern that cannot compile is reported, not thrown', () => {
  const { rules, errors } = compileRedactionRules([
    { pattern: '(unclosed', replacement: 'x', flags: 'g' },
    { pattern: 'fine', replacement: 'x', flags: 'g' }
  ]);
  assert.equal(rules.length, 1, 'the valid rule survives');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not a valid regular expression/);
});

test('the g flag is forced on even if the user omits it', () => {
  const { rules } = compileRedactionRules([{ pattern: 'x', flags: 'i' }]);
  assert.ok(rules[0].regex.flags.includes('g'));
  assert.ok(rules[0].regex.flags.includes('i'));
});

test('nested content is reached at any depth', () => {
  const rules = compile(['deep']);
  const { value } = applyRedactionRules(
    { a: [{ b: { c: [{ d: 'a deep secret' }] } }] },
    rules
  );
  assert.equal(value.a[0].b.c[0].d, 'a [redacted] secret');
});
