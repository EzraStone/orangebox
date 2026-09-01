// §19.8 — the tools view's arithmetic, without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sortTools, timingConfidence, headline, SORTS } from '../ui/tools.js';

const tool = (key, over = {}) => ({
  key, uses: 1, runs: 1, errors: 0, unanswered: 0, error_rate: 0,
  timed_uses: 1, avg_ms: 100, total_ms: 100, slowest_ms: 100, ...over
});

test('sorting by slowest puts unknown timing last, not first', () => {
  // A tool with no timing is unknown, not instant. Treating null as 0 would
  // rank the tools we know least about as the fastest things in the list.
  const rows = sortTools([
    tool('unknown', { avg_ms: null, timed_uses: 0 }),
    tool('quick', { avg_ms: 50 }),
    tool('slow', { avg_ms: 9000 })
  ], 'slow');

  assert.deepEqual(rows.map((t) => t.key), ['slow', 'quick', 'unknown']);
});

test('each sort orders by the thing it names', () => {
  const rows = [
    tool('a', { uses: 1, errors: 5, unanswered: 0, avg_ms: 10 }),
    tool('b', { uses: 9, errors: 0, unanswered: 1, avg_ms: 20 }),
    tool('c', { uses: 3, errors: 1, unanswered: 7, avg_ms: 30 })
  ];
  assert.equal(sortTools(rows, 'uses')[0].key, 'b');
  assert.equal(sortTools(rows, 'errors')[0].key, 'a');
  assert.equal(sortTools(rows, 'unanswered')[0].key, 'c');
  assert.equal(sortTools(rows, 'slow')[0].key, 'c');
});

test('sorting does not mutate the source rows', () => {
  const rows = [tool('a', { uses: 1 }), tool('b', { uses: 9 })];
  sortTools(rows, 'uses');
  assert.deepEqual(rows.map((t) => t.key), ['a', 'b']);
});

test('an unknown sort falls back to most-used rather than throwing', () => {
  const rows = sortTools([tool('a', { uses: 1 }), tool('b', { uses: 4 })], 'nonsense');
  assert.equal(rows[0].key, 'b');
  assert.deepEqual(sortTools(undefined), []);
});

test('timing confidence distinguishes unknown from partly known', () => {
  assert.deepEqual(
    timingConfidence(tool('x', { avg_ms: null, timed_uses: 0, uses: 4 })),
    { known: false, note: 'never used alone, so no gap belongs to it' }
  );

  const partial = timingConfidence(tool('y', { avg_ms: 500, timed_uses: 2, uses: 9 }));
  assert.equal(partial.known, true);
  assert.equal(partial.partial, true);
  assert.match(partial.note, /2 of 9/);

  const full = timingConfidence(tool('z', { avg_ms: 500, timed_uses: 3, uses: 3 }));
  assert.equal(full.partial, false);
  assert.equal(full.note, null);
});

test('the headline counts only the problems that exist', () => {
  assert.equal(headline({ total_uses: 0 }), null);
  assert.equal(headline(null), null);
  assert.equal(headline({ total_uses: 1, total_errors: 0, total_unanswered: 0 }), '1 tool call');
  assert.match(headline({ total_uses: 9, total_errors: 2, total_unanswered: 0 }), /9 tool calls · 2 errored/);
  assert.match(headline({ total_uses: 9, total_errors: 0, total_unanswered: 3 }), /3 never answered/);
});

test('every sort option the UI offers is one sortTools understands', () => {
  const rows = [tool('a', { uses: 2 }), tool('b', { uses: 1 })];
  for (const [value] of SORTS) {
    assert.equal(sortTools(rows, value).length, 2, `sort "${value}" broke`);
  }
});
