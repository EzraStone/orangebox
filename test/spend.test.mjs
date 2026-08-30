// §19.5 — the spend view's arithmetic. No DOM here: these are the functions
// that decide what the chart claims, and they are worth checking on their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  topGroups,
  barGeometry,
  chartHeight,
  coverageNote,
  shortKey,
  CHART_ROWS
} from '../ui/spend.js';

const group = (key, cost, extra = {}) => ({
  key,
  calls: 1,
  input_tokens: 100,
  output_tokens: 50,
  cost_usd: cost,
  unpriced_calls: 0,
  error_calls: 0,
  ...extra
});

test('a short list of groups passes through untouched', () => {
  const groups = [group('a', 3), group('b', 2)];
  const out = topGroups(groups, 12);
  assert.deepEqual(out, groups);
  assert.notEqual(out, groups, 'returns a copy, so the caller cannot mutate the source');
});

test('groups past the row limit are folded up, not dropped (§19.5)', () => {
  // Fifteen groups of $1 each. Twelve rows means eleven survive individually
  // and the last four become one bar — and the money has to still be there.
  const groups = Array.from({ length: 15 }, (_, i) => group(`m${i}`, 1, { calls: 2 }));
  const out = topGroups(groups, 12);

  assert.equal(out.length, 12);
  const rollup = out.at(-1);
  assert.equal(rollup.key, '4 more');
  assert.equal(rollup.rollup, true);
  assert.equal(rollup.cost_usd, 4);
  assert.equal(rollup.calls, 8);

  const charted = out.reduce((sum, g) => sum + g.cost_usd, 0);
  const actual = groups.reduce((sum, g) => sum + g.cost_usd, 0);
  assert.equal(charted, actual, 'the chart must total the same as the source');
});

test('the rollup carries the unpriced count with it', () => {
  // The tail is where cheap, obscure, unpriced models end up. If folding them
  // together lost the flag, the one bar hiding the most uncertainty would be
  // the only bar not marked.
  const groups = [
    ...Array.from({ length: 11 }, (_, i) => group(`known${i}`, 5)),
    group('mystery-a', 0, { unpriced_calls: 3, calls: 3 }),
    group('mystery-b', 0, { unpriced_calls: 4, calls: 4 })
  ];
  const rollup = topGroups(groups, 12).at(-1);
  assert.equal(rollup.unpriced_calls, 7);
});

test('bar widths scale to the largest group', () => {
  const bars = barGeometry([group('big', 10), group('half', 5)], {
    width: 640,
    labelWidth: 168,
    valueWidth: 96
  });
  const track = 640 - 168 - 96;
  assert.equal(bars[0].width, track);
  assert.equal(bars[1].width, track / 2);
  assert.equal(bars[0].x, 168);
  assert.equal(bars[1].y, 26);
});

test('a free call draws a hairline, not nothing (§08)', () => {
  // Ollama and other local runtimes cost exactly 0. A zero-width bar would
  // make "this ran for free" look the same as "this is not in the data".
  const bars = barGeometry([group('gpt-5', 4), group('llama3.2', 0)]);
  assert.ok(bars[1].width > 0, 'a $0 group still gets a visible bar');
  assert.ok(bars[1].width < bars[0].width / 100, 'but it stays visibly tiny');
});

test('every bar is a hairline when nothing cost anything', () => {
  // All-local workloads: max is 0, and dividing by it must not produce NaN
  // widths, which render as an invisible chart with no error anywhere.
  const bars = barGeometry([group('llama3.2', 0), group('qwen3', 0)]);
  for (const bar of bars) {
    assert.ok(Number.isFinite(bar.width), 'width is a real number');
    assert.ok(bar.width > 0);
  }
});

test('bars carrying unpriced calls are marked partial', () => {
  const bars = barGeometry([group('priced', 2), group('unpriced', 1, { unpriced_calls: 5 })]);
  assert.equal(bars[0].partial, false);
  assert.equal(bars[1].partial, true);
});

test('an empty chart still has height', () => {
  assert.ok(chartHeight(0) > 0);
  assert.equal(chartHeight(3, 26), 78);
});

test('a fully priced total gets no coverage warning', () => {
  const note = coverageNote({ total_calls: 40, unpriced_calls: 0, priced_share: 1 });
  assert.equal(note, null);
});

test('an incomplete total says so, with the numbers (§19.5)', () => {
  // This is the whole point of the view. The figure on screen is too low and
  // the text next to it has to say by roughly how much, or the user reads a
  // wrong number as a right one.
  const note = coverageNote({
    total_calls: 100,
    unpriced_calls: 30,
    unrated_calls: 30,
    no_usage_calls: 0,
    priced_share: 0.7
  });
  assert.ok(note, 'a warning is produced');
  assert.match(note, /70%/);
  assert.match(note, /30 of 100/);
  assert.match(note, /higher/, 'says which direction the error runs in');
  assert.match(note, /pricing\.json/, 'says how to fix it');
});

test('calls that never reported tokens are not blamed on pricing.json', () => {
  // The bug this split fixes. An errored or aborted call has no cost because
  // it has no token counts, and sending someone to edit a rates file for that
  // is advice that cannot possibly work.
  const note = coverageNote({
    total_calls: 10,
    unpriced_calls: 2,
    unrated_calls: 0,
    no_usage_calls: 2,
    priced_share: 0.8
  });
  assert.doesNotMatch(note, /pricing\.json/, 'no rate file advice when no rate is missing');
  assert.match(note, /never reported token counts/);
  assert.match(note, /unknowable/);
});

test('both causes at once are reported separately', () => {
  const note = coverageNote({
    total_calls: 20,
    unpriced_calls: 7,
    unrated_calls: 5,
    no_usage_calls: 2,
    priced_share: 0.65
  });
  assert.match(note, /7 of 20/, 'the combined shortfall leads');
  assert.match(note, /5 had no pricing entry/);
  assert.match(note, /2 never reported token counts/);
  assert.match(note, /pricing\.json/);
});

test('a payload without the breakdown stays neutral about the cause', () => {
  // Older responses carry only the combined count. Guessing "missing rate"
  // there is precisely the wrong answer this change removed.
  const note = coverageNote({ total_calls: 100, unpriced_calls: 30, priced_share: 0.7 });
  assert.match(note, /30 of 100/);
  assert.doesNotMatch(note, /pricing\.json/, 'does not invent a cause it was not told');
});

test('no calls means no warning to give', () => {
  assert.equal(coverageNote({ total_calls: 0, unpriced_calls: 0, priced_share: 1 }), null);
  assert.equal(coverageNote(null), null);
  assert.equal(coverageNote(undefined), null);
});

test('a total with nothing priced at all is still reported honestly', () => {
  const note = coverageNote({
    total_calls: 12,
    unpriced_calls: 12,
    unrated_calls: 12,
    no_usage_calls: 0,
    priced_share: 0
  });
  assert.match(note, /0%/);
  assert.match(note, /12 of 12/);
});

test('long group keys are ellipsised rather than overflowing the gutter', () => {
  assert.equal(shortKey('gpt-5', 26), 'gpt-5');
  const long = shortKey('claude-opus-4-5-20250929-preview', 26);
  assert.equal(long.length, 26);
  assert.ok(long.endsWith('…'));
  assert.equal(shortKey(null), '');
});

test('the row limit is a number the chart and the folder agree on', () => {
  assert.equal(typeof CHART_ROWS, 'number');
  assert.equal(topGroups(Array.from({ length: CHART_ROWS + 5 }, (_, i) => group(`m${i}`, 1))).length, CHART_ROWS);
});

test('the rollup carries both shortfall reasons, not just the total', () => {
  // The tail is where obscure models and failed calls both collect. Folding
  // them together must not lose which kind they were, or the one bar hiding
  // the most uncertainty becomes the least explained.
  const groups = [
    ...Array.from({ length: 11 }, (_, i) => group(`known${i}`, 5)),
    group('mystery', 0, { unpriced_calls: 3, unrated_calls: 3, no_usage_calls: 0, calls: 3 }),
    group('flaky', 0, { unpriced_calls: 4, unrated_calls: 0, no_usage_calls: 4, calls: 4 })
  ];
  const rollup = topGroups(groups, 12).at(-1);
  assert.equal(rollup.unpriced_calls, 7);
  assert.equal(rollup.unrated_calls, 3);
  assert.equal(rollup.no_usage_calls, 4);
});
