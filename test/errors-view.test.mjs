// §19.10 — the errors view's arithmetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { severity, summary, spread } from '../ui/errors.js';

test('severity is banded, not a gradient', () => {
  // Thresholds on purpose: a smooth scale invites comparing failures to each
  // other, when the only comparison that matters is against zero.
  assert.equal(severity(0.5), 'high');
  assert.equal(severity(0.2), 'high');
  assert.equal(severity(0.19), 'medium');
  assert.equal(severity(0.05), 'medium');
  assert.equal(severity(0.01), 'low');
  assert.equal(severity(0), 'low');
});

test('a window with no failures says so instead of showing nothing', () => {
  // An empty list is indistinguishable from a view that has not loaded.
  assert.equal(summary({ total_calls: 40, total_errors: 0, error_rate: 0 }), '40 calls, none failed.');
  assert.equal(summary({ total_calls: 0 }), 'No calls recorded in this window.');
  assert.equal(summary(null), 'No calls recorded in this window.');
});

test('the summary leads with the rate, not the count', () => {
  const text = summary({ total_calls: 900, total_errors: 12, error_rate: 12 / 900 });
  assert.match(text, /12 of 900/);
  assert.match(text, /1\.3%/);
});

test('spread describes how far an error has reached', () => {
  assert.equal(spread({ runs: 1, providers: ['openai'], models: 1 }), '1 run · openai');
  assert.equal(
    spread({ runs: 4, providers: ['anthropic', 'gemini'], models: 3 }),
    '4 runs · anthropic, gemini · 3 models'
  );
  // A single model is not worth a clause; the run count already implies scope.
  assert.equal(spread({ runs: 2, providers: [], models: 1 }), '2 runs');
});
