// §27 — the context strip's wording and its chart geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fmt } from '../ui/dom.js';

/** Both are pure; lift them out of app.js rather than duplicating them. */
function lift(name, scope = {}) {
  const source = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${name} not found in app.js`);
  const end = source.indexOf('\n}', start) + 2;
  const keys = Object.keys(scope);
  const body = `${source.slice(start, end).replace('export function', 'function')}; return ${name};`;
  return new Function(...keys, body)(...keys.map((k) => scope[k]));
}

const contextSummary = lift('contextSummary', { fmt });

test('a run that did not grow gets no strip', () => {
  // "Your prompt stayed the same size" is not news, and a panel that always
  // renders is a panel people stop seeing.
  assert.equal(contextSummary(null), null);
  assert.equal(contextSummary({ calls: 0 }), null);
  assert.equal(contextSummary({ calls: 30, growth: 1.1 }), null);
});

test('a short run is left alone even when it grew', () => {
  assert.equal(contextSummary({ calls: 3, growth: 40 }), null);
});

test('a growing run is described with both ends of the range', () => {
  const summary = contextSummary({
    calls: 12, growth: 9.4, first_tokens: 1200, peak_tokens: 11280,
    total_input_tokens: 74000, cached_share: 0.02, series: [1, 2, 3]
  });
  assert.match(summary.headline, /9\.4× over 12 calls/);
  assert.match(summary.detail, /1\.2k to 11k/);
  assert.match(summary.detail, /74k sent in total/);
  assert.equal(summary.actionable, true);
});

test('growth that was cached is reported but not flagged', () => {
  const summary = contextSummary({
    calls: 12, growth: 9.4, first_tokens: 1200, peak_tokens: 11280,
    total_input_tokens: 74000, cached_share: 0.88
  });
  assert.match(summary.cached, /88% served from cache/);
  assert.equal(summary.actionable, false, 'nothing to act on when the cache is already doing the work');
});

test('no caching at all is said plainly rather than as "0%"', () => {
  const summary = contextSummary({
    calls: 9, growth: 6, first_tokens: 1000, peak_tokens: 6000,
    total_input_tokens: 20000, cached_share: 0
  });
  assert.equal(summary.cached, 'none of it served from cache');
});

test('a missing cached share is treated as none, not as unknown growth', () => {
  const summary = contextSummary({
    calls: 9, growth: 6, first_tokens: 1000, peak_tokens: 6000, total_input_tokens: 20000
  });
  assert.equal(summary.actionable, true);
  assert.ok(Array.isArray(summary.series));
});
