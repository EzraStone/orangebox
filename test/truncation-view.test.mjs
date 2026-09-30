// §29 — the wording of the cut-off banner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fmt } from '../ui/dom.js';

/** truncationSummary is pure; lift it out of app.js rather than copying it. */
function lift(name, scope) {
  const source = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} not found in app.js`);
  const end = source.indexOf('\n}', start) + 2;
  const keys = Object.keys(scope);
  return new Function(...keys, `${source.slice(start, end).replace('export function', 'function')}; return ${name};`)(
    ...keys.map((k) => scope[k])
  );
}

const truncationSummary = lift('truncationSummary', { fmt });
const call = (seq, output_tokens = 4096) => ({ seq, output_tokens, stop_reason: 'max_tokens' });

test('a run with nothing cut off gets no banner', () => {
  assert.equal(truncationSummary(null), null);
  assert.equal(truncationSummary({ truncated_calls: 0, calls: [] }), null);
});

test('one cut-off response is described in the singular', () => {
  const summary = truncationSummary({ truncated_calls: 1, calls: [call(7)] });
  assert.match(summary.headline, /^1 response was cut off/);
  assert.match(summary.detail, /^Call 07/);
});

test('a shared limit is named, because it is usually the fix', () => {
  const summary = truncationSummary({ truncated_calls: 2, calls: [call(3), call(9)] });
  assert.match(summary.detail, /each stopped at 4096 tokens/);
  // No request parameter known, so the advice stays general.
  assert.match(summary.advice, /Raise the output limit/);
});

test('the advice uses the provider’s own name for the parameter', () => {
  // "max_tokens" is the wrong word to give someone whose client sends
  // max_completion_tokens; they would go looking for a setting they do not have.
  const limited = (seq) => ({ ...call(seq), limit: { field: 'max_completion_tokens', value: 4096 } });
  const summary = truncationSummary({ truncated_calls: 2, calls: [limited(3), limited(9)] });
  assert.match(summary.advice, /Raise max_completion_tokens/);

  const mixed = truncationSummary({ truncated_calls: 2, calls: [limited(3), { ...call(9), limit: { field: 'max_tokens', value: 4096 } }] });
  assert.match(mixed.advice, /Raise the output limit/, 'two different parameters: name neither');
});

test('different limits are not summarised as one', () => {
  const summary = truncationSummary({ truncated_calls: 2, calls: [call(3, 1024), call(9, 4096)] });
  assert.equal(summary.detail.includes('each stopped at'), false);
});

test('a long list of calls is shortened rather than wrapped across the banner', () => {
  const calls = Array.from({ length: 11 }, (_, i) => call(i + 1));
  const summary = truncationSummary({ truncated_calls: 11, calls });
  assert.match(summary.detail, /01, 02, 03, 04, 05, 06, and 5 more/);
});
