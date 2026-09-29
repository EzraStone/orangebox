// One rule for printing a token count, in two places that cannot import each
// other, checked against each other.
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatTokens, formatUsd } from '../src/format.mjs';
import { fmt } from '../ui/dom.js';

const CASES = [
  [0, '0'],
  [1, '1'],
  [999, '999'],
  [1000, '1000'],
  [9999, '9999'],
  [10_000, '10.0k'],
  [24_500, '24.5k'],
  [99_999, '100.0k'],
  [147_382, '147k'],
  [999_499, '999k'],
  [1_000_000, '1.0M'],
  [2_400_000, '2.4M']
];

test('a token count is exact until it stops being comparable', () => {
  // "1.2k" throws away digits that cost nothing to keep, and nobody compares
  // 147,382 against 22,904 without rounding them in their head first.
  for (const [value, expected] of CASES) {
    assert.equal(formatTokens(value), expected, `${value}`);
  }
});

test('an unknown count is an em-dash, not a zero', () => {
  // "orangebox does not know" and "the answer is zero" are different claims.
  assert.equal(formatTokens(null), '—');
  assert.equal(formatTokens(undefined), '—');
  assert.equal(formatTokens(Number.NaN), '—');
  assert.equal(formatTokens(0), '0');
});

test('nothing renders as a thousand thousands', () => {
  // 999,999 used to print as "1000k", which is a unit nobody uses and which
  // reads as ten times its value at a glance.
  for (let value = 999_000; value <= 1_001_000; value += 100) {
    assert.equal(formatTokens(value).includes('1000k'), false, `${value} rendered as 1000k`);
  }
});

test('the browser copy and the node one agree', () => {
  // ui/dom.js cannot import src/format.mjs — ui/ is served as static assets
  // with no build step — so this is what keeps them one rule. They disagreed
  // across most of the useful range: 24,500 read as "24.5k" in the terminal
  // and "25k" in the browser, for the same number on the same run.
  for (const [value] of CASES) {
    assert.equal(fmt.tokens(value), formatTokens(value), `${value}`);
  }
  for (const value of [null, undefined, Number.NaN]) {
    assert.equal(fmt.tokens(value), formatTokens(value));
  }

  // And across a wider sweep than the table, so a boundary moved in one place
  // and not the other is caught.
  for (let value = 0; value < 2_000_000; value += 997) {
    assert.equal(fmt.tokens(value), formatTokens(value), `${value}`);
  }
});

const COST_CASES = [
  [0, '$0'],
  [0.0001, '$0.0001'],
  [0.005, '$0.0050'],
  [0.01, '$0.010'],
  [0.999, '$0.999'],
  [1, '$1.00'],
  [12.345, '$12.35'],
  [1234.5, '$1234.50']
];

test('a cost is printed at the precision it deserves', () => {
  // Four decimals below a cent, because $0.0003 is a real answer and "$0.00"
  // is not. Two above a dollar, because nobody reads hundredths of a cent on
  // a twelve-dollar bill.
  for (const [value, expected] of COST_CASES) {
    assert.equal(formatUsd(value), expected, `${value}`);
  }
});

test('nothing costs "$0", not "$0.0000"', () => {
  // A local model really does cost nothing (§08), and four decimals of nothing
  // reads like a rounding error rather than an answer.
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd(null), '—');
  assert.equal(formatUsd(undefined), '—');
});

test('the browser copy and the node one agree about money too', () => {
  for (const [value] of COST_CASES) {
    assert.equal(fmt.usd(value), formatUsd(value), `${value}`);
  }
  for (const value of [null, undefined, Number.NaN]) {
    assert.equal(fmt.usd(value), formatUsd(value));
  }
  for (let cents = 0; cents < 200_000; cents += 37) {
    const value = cents / 10_000;
    assert.equal(fmt.usd(value), formatUsd(value), `${value}`);
  }
});
