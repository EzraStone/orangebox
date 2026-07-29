// §21.3 — line diffing, the v1 differentiator pulled forward from §19.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffLines, collapseUnchanged, diffStats, LCS_CELL_BUDGET } from '../ui/diff.js';

const render = (ops) => ops.map((o) => `${o.t}${o.text ?? ''}`);

test('identical input produces no changes', () => {
  const lines = ['a', 'b', 'c'];
  const ops = diffLines(lines, lines);
  assert.deepEqual(render(ops), ['=a', '=b', '=c']);
  assert.deepEqual(diffStats(ops), { added: 0, removed: 0, identical: true });
});

test('an appended tail shows as additions only — the agent-turn case', () => {
  // Consecutive calls in a run share the whole history and add to the end.
  const before = ['{', '  "messages": [', '    "one"', '  ]', '}'];
  const after = ['{', '  "messages": [', '    "one",', '    "two"', '  ]', '}'];

  const ops = diffLines(before, after);
  const { added, removed } = diffStats(ops);
  assert.equal(added, 2);
  assert.equal(removed, 1); // `"one"` gained a comma
  // The unchanged frame survives on both ends.
  assert.equal(ops[0].t, '=');
  assert.equal(ops.at(-1).t, '=');
  assert.equal(ops.at(-1).text, '}');
});

test('a changed line in the middle is a paired delete and add', () => {
  const ops = diffLines(['a', 'b', 'c'], ['a', 'B', 'c']);
  assert.deepEqual(render(ops), ['=a', '-b', '+B', '=c']);
});

test('reconstruction: applying the ops rebuilds both sides exactly', () => {
  const a = 'the quick brown fox jumps over the lazy dog'.split(' ');
  const b = 'the quick red fox leaps over a lazy dog today'.split(' ');
  const ops = diffLines(a, b);

  const left = ops.filter((o) => o.t !== '+').map((o) => o.text);
  const right = ops.filter((o) => o.t !== '-').map((o) => o.text);
  assert.deepEqual(left, a);
  assert.deepEqual(right, b);
});

test('empty sides degrade cleanly', () => {
  assert.deepEqual(render(diffLines([], ['x'])), ['+x']);
  assert.deepEqual(render(diffLines(['x'], [])), ['-x']);
  assert.deepEqual(diffLines([], []), []);
});

test('a huge changed middle falls back to wholesale replacement, not an OOM', () => {
  // Shared prefix/suffix are trimmed first, so the budget only sees the middle.
  const size = Math.ceil(Math.sqrt(LCS_CELL_BUDGET)) + 200;
  const a = ['head', ...Array.from({ length: size }, (_, i) => `a${i}`), 'tail'];
  const b = ['head', ...Array.from({ length: size }, (_, i) => `b${i}`), 'tail'];

  const started = Date.now();
  const ops = diffLines(a, b);
  assert.ok(Date.now() - started < 5000, 'stays fast rather than grinding');

  const { added, removed } = diffStats(ops);
  assert.equal(removed, size);
  assert.equal(added, size);
  assert.equal(ops[0].text, 'head');
  assert.equal(ops.at(-1).text, 'tail');
});

test('a big shared payload with one edit stays cheap and precise', () => {
  const shared = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  const a = [...shared];
  const b = [...shared];
  b[2500] = 'line 2500 CHANGED';

  const started = Date.now();
  const ops = diffLines(a, b);
  assert.ok(Date.now() - started < 500, 'prefix/suffix trimming keeps the LCS tiny');
  assert.deepEqual(diffStats(ops), { added: 1, removed: 1, identical: false });
});

test('long unchanged stretches collapse but changes keep their context', () => {
  const ops = diffLines(
    Array.from({ length: 40 }, (_, i) => `l${i}`),
    Array.from({ length: 40 }, (_, i) => (i === 20 ? 'CHANGED' : `l${i}`))
  );

  const collapsed = collapseUnchanged(ops, 3);
  const skips = collapsed.filter((o) => o.t === 'skip');
  assert.equal(skips.length, 2, 'one collapsed run either side of the change');
  assert.ok(skips[0].count > 10);

  // The change and three lines of context around it survive.
  const texts = collapsed.filter((o) => o.t !== 'skip').map((o) => o.text);
  assert.ok(texts.includes('CHANGED'));
  assert.ok(texts.includes('l19'));
  assert.ok(texts.includes('l21'));

  // Every collapsed line is accounted for.
  const kept = collapsed.filter((o) => o.t !== 'skip').length;
  const skipped = skips.reduce((n, s) => n + s.count, 0);
  assert.equal(kept + skipped, ops.length);
});

test('short unchanged runs are left alone', () => {
  const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'b', 'X', 'd']);
  assert.deepEqual(collapseUnchanged(ops, 3), ops);
});
