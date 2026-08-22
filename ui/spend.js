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

import { el, fmt } from './dom.js';

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

// =========================================================== rendering

export const state = {
  group: 'model',
  days: '',
  data: null,
  loading: false,
  error: null
};

/** Fetch the current grouping. Never throws — the view renders the failure. */
export async function loadSpend(get) {
  state.loading = true;
  state.error = null;
  try {
    const params = new URLSearchParams({ group: state.group });
    if (state.days) params.set('since', String(Date.now() - Number(state.days) * 86_400_000));
    state.data = await get(`/api/spend?${params}`);
  } catch (err) {
    state.data = null;
    state.error = String(err?.message ?? err);
  } finally {
    state.loading = false;
  }
}

function segmented(options, current, apply, onChange, label) {
  const wrap = el('div', { class: 'segmented', role: 'group', 'aria-label': label });
  for (const [value, text] of options) {
    wrap.append(
      el('button', {
        class: 'seg',
        type: 'button',
        'aria-pressed': String(current === value),
        text,
        on: {
          click: () => {
            if (current === value) return;
            apply(value);
            onChange();
          }
        }
      })
    );
  }
  return wrap;
}

function chart(groups) {
  const bars = barGeometry(groups);
  const height = chartHeight(bars.length);
  const total = groups.reduce((sum, g) => sum + (Number(g.cost_usd) || 0), 0);

  const svg = el('svg', {
    class: 'spend-chart',
    viewBox: `0 0 640 ${height}`,
    preserveAspectRatio: 'xMinYMin meet',
    role: 'img',
    'aria-label': `Spend by ${state.group}: ${bars.length} rows totalling ${fmt.usd(total)}`
  });

  for (const bar of bars) {
    const g = bar.group;
    svg.append(
      el('text', {
        class: g.rollup ? 'spend-bar-label rollup' : 'spend-bar-label',
        x: bar.x - 10,
        y: bar.y + 17,
        'text-anchor': 'end',
        text: shortKey(g.key)
      }),
      el('rect', {
        class: bar.partial ? 'spend-bar partial' : 'spend-bar',
        x: bar.x,
        y: bar.y + 5,
        width: bar.width,
        height: bar.height,
        rx: 2
      }),
      el('text', {
        class: 'spend-bar-value',
        x: bar.x + bar.width + 8,
        y: bar.y + 17,
        text: `${fmt.usd(g.cost_usd)}${bar.partial ? '+' : ''}`
      })
    );
  }

  return svg;
}

function table(groups) {
  const heading = GROUPS.find(([k]) => k === state.group)?.[1] ?? 'Group';

  const head = el('tr', {}, [
    el('th', { scope: 'col', text: heading }),
    el('th', { scope: 'col', class: 'num', text: 'Calls' }),
    el('th', { scope: 'col', class: 'num', text: 'In' }),
    el('th', { scope: 'col', class: 'num', text: 'Out' }),
    el('th', { scope: 'col', class: 'num', text: 'Est. cost' })
  ]);

  const rows = groups.map((g) => {
    const flags = [];
    if (g.unpriced_calls > 0) {
      flags.push(
        el('span', {
          class: 'spend-flag',
          title: `${g.unpriced_calls} of ${g.calls} calls have no pricing entry, so this row is an under-estimate`,
          text: ` ${g.unpriced_calls} unpriced`
        })
      );
    }
    if (g.error_calls > 0) {
      flags.push(
        el('span', {
          class: 'spend-err',
          title: `${g.error_calls} of ${g.calls} calls failed`,
          text: ` ${g.error_calls} errored`
        })
      );
    }

    return el('tr', { class: g.rollup ? 'rollup' : null }, [
      el('td', {}, [el('span', { class: 'spend-key', text: String(g.key) }), ...flags]),
      el('td', { class: 'num', text: String(g.calls) }),
      el('td', { class: 'num', text: fmt.tokens(g.input_tokens) }),
      el('td', { class: 'num', text: fmt.tokens(g.output_tokens) }),
      el('td', { class: 'num', text: `${fmt.usd(g.cost_usd)}${g.unpriced_calls > 0 ? '+' : ''}` })
    ]);
  });

  return el('table', { class: 'spend-table' }, [
    el('thead', {}, [head]),
    el('tbody', {}, rows)
  ]);
}

function note(text) {
  return el('p', { class: 'spend-note', text });
}

/**
 * Draw the whole view into `host`. `onChange` re-runs the load and calls back
 * in here; the view owns no scheduling of its own.
 */
export function renderSpend(host, onChange) {
  const body = el('div', { class: 'spend' });

  body.append(
    el('div', { class: 'spend-controls' }, [
      el('span', { class: 'spend-ctl-label', text: 'group by' }),
      segmented(GROUPS, state.group, (v) => (state.group = v), onChange, 'Group spend by'),
      el('span', { class: 'spend-ctl-gap' }),
      el('span', { class: 'spend-ctl-label', text: 'window' }),
      segmented(WINDOWS, state.days, (v) => (state.days = v), onChange, 'Time window')
    ])
  );

  const data = state.data;

  if (state.error) {
    body.append(note(`Could not load spend: ${state.error}`));
  } else if (state.loading && !data) {
    body.append(note('Loading…'));
  } else if (!data || !data.total_calls) {
    body.append(
      note('No calls recorded in this window. Widen the range, or point an agent at orangebox and run it.')
    );
  } else {
    body.append(
      el('div', { class: 'spend-total' }, [
        el('span', {
          class: data.unpriced_calls > 0 ? 'spend-total-value partial' : 'spend-total-value',
          text: `${fmt.usd(data.total_cost_usd)}${data.unpriced_calls > 0 ? '+' : ''}`
        }),
        el('span', {
          class: 'spend-total-sub',
          text: `estimated across ${data.total_calls} call${data.total_calls === 1 ? '' : 's'}`
        })
      ])
    );

    // The honest bit, in the same breath as the number it qualifies.
    const warning = coverageNote(data);
    if (warning) body.append(el('div', { class: 'banner spend-banner', role: 'status', text: warning }));

    const groups = topGroups(data.groups ?? []);
    body.append(chart(groups), table(groups));
  }

  host.replaceChildren(body);
}
