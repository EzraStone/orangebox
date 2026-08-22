// §19.5 — where the money went. Groups recorded calls by model, provider, run
// or day and draws the result.
//
// One rule shapes everything below: never show a total without showing how
// complete it is. orangebox prices a call by looking its model up in
// pricing.json; a model that is not in the table costs null, not zero. Sum a
// column of those naively and you get a number that is confidently too low,
// with nothing on screen to tell you to distrust it. So the unpriced count
// travels with the total everywhere it goes, and the chart marks the bars it
// affects.

export const GROUPS = [
  ['model', 'Model'],
  ['provider', 'Provider'],
  ['run', 'Run'],
  ['day', 'Day']
];

export const WINDOWS = [
  ['', 'All time'],
  ['1', '24 hours'],
  ['7', '7 days'],
  ['30', '30 days']
];

/** Bars beyond this get folded into one "other" row rather than dropped. */
export const CHART_ROWS = 12;

/**
 * Take the top rows by cost and fold the tail into a single summary row.
 * Truncating the list instead would quietly hide spend: the chart would total
 * visibly less than the headline figure and nothing would say why.
 */
export function topGroups(groups, limit = CHART_ROWS) {
  if (!Array.isArray(groups)) return [];
  if (groups.length <= limit) return groups.slice();

  const head = groups.slice(0, limit - 1);
  const tail = groups.slice(limit - 1);
  const sum = (key) => tail.reduce((acc, g) => acc + (Number(g[key]) || 0), 0);

  return [
    ...head,
    {
      key: `${tail.length} more`,
      calls: sum('calls'),
      input_tokens: sum('input_tokens'),
      output_tokens: sum('output_tokens'),
      cost_usd: sum('cost_usd'),
      unpriced_calls: sum('unpriced_calls'),
      error_calls: sum('error_calls'),
      rollup: true
    }
  ];
}

/**
 * Bar positions for the chart, in viewBox units. Pure so the geometry can be
 * checked without a DOM.
 *
 * A zero-cost group still gets a hairline. Local models really do cost $0
 * (§08), and a bar of width 0 would make "free" look identical to "absent".
 */
export function barGeometry(groups, { width = 640, labelWidth = 168, rowHeight = 26, valueWidth = 96 } = {}) {
  const track = Math.max(width - labelWidth - valueWidth, 1);
  const max = groups.reduce((m, g) => Math.max(m, Number(g.cost_usd) || 0), 0);

  return groups.map((g, i) => {
    const cost = Number(g.cost_usd) || 0;
    const w = max > 0 ? Math.max((cost / max) * track, 1.5) : 1.5;
    return {
      group: g,
      x: labelWidth,
      y: i * rowHeight,
      width: w,
      height: rowHeight - 12,
      // Bars with unpriced calls are drawn hatched: the bar is shorter than
      // the truth and the eye should not read it as a clean measurement.
      partial: (Number(g.unpriced_calls) || 0) > 0
    };
  });
}

/** Total viewBox height for n rows, never zero (an empty svg collapses oddly). */
export function chartHeight(rows, rowHeight = 26) {
  return Math.max(rows * rowHeight, rowHeight);
}

/**
 * The sentence that goes next to the total when the total is incomplete, or
 * null when it is not. Returned as data rather than markup so a test can read
 * it, and so it is impossible to render the total without having asked.
 */
export function coverageNote(data) {
  if (!data || !data.total_calls) return null;
  const missing = Number(data.unpriced_calls) || 0;
  if (missing === 0) return null;

  const pct = Math.round((Number(data.priced_share) || 0) * 100);
  return (
    `This total covers ${pct}% of recorded calls. ` +
    `${missing} of ${data.total_calls} had no pricing entry for their model, so the real figure is higher. ` +
    `Add rates to ~/.orangebox/pricing.json to close the gap.`
  );
}

/** Truncate a long key for the chart gutter without breaking the layout. */
export function shortKey(key, max = 26) {
  const s = String(key ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
