// §30 — the diagnosis view's wording.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosisSummary, FINDING_LABELS } from '../ui/diagnosis.js';

test('an empty window says so rather than drawing an empty list', () => {
  assert.equal(diagnosisSummary(null), 'No runs recorded in this window.');
  assert.equal(diagnosisSummary({ checked_runs: 0, flagged_runs: 0, counts: {} }), 'No runs recorded in this window.');
});

test('a clean window is said outright', () => {
  // An empty list looks like a loading state. "Nothing wrong" is an answer.
  assert.equal(diagnosisSummary({ checked_runs: 1, flagged_runs: 0, counts: {} }), 'Nothing wrong found in 1 run.');
  assert.equal(diagnosisSummary({ checked_runs: 12, flagged_runs: 0, counts: {} }), 'Nothing wrong found in 12 runs.');
});

test('only the kinds that were found are named', () => {
  const text = diagnosisSummary({ checked_runs: 20, flagged_runs: 3, counts: { truncated: 2, loop: 0, growth: 1 } });
  assert.equal(text, '3 of 20 runs need a look — 2 with cut-off answers, 1 with runaway context.');
  assert.equal(text.includes('looping'), false);
});

test('every kind the server can report has a label', async () => {
  // A new kind added server-side without a label here would render its raw
  // internal name in the list.
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../src/diagnosis.mjs', import.meta.url), 'utf8');
  const kinds = [...source.matchAll(/kind: '([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 3, `only found ${kinds.length} kinds`);
  for (const kind of kinds) assert.ok(FINDING_LABELS[kind], `no label for "${kind}"`);
});
