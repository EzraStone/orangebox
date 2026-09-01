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

import { el, fmt, segmented, WINDOWS } from './dom.js';

export const GROUPS = [
  ['model', 'Model'],
  ['provider', 'Provider'],
  ['run', 'Run'],
  ['day', 'Day']
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
      unrated_calls: sum('unrated_calls'),
      no_usage_calls: sum('no_usage_calls'),
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
 * The sentence beside the total when the total is incomplete, or null when it
 * is not. Returned as data rather than markup so a test can read it, and so it
 * is impossible to render the total without having asked.
 *
 * It names the causes separately because the remedies are opposite: a missing
 * rate is fixed by editing pricing.json, and a call that never reported tokens
 * is not fixed by anything you can type into that file.
 */
export function coverageNote(data) {
  if (!data || !data.total_calls) return null;

  const missing = Number(data.unpriced_calls) || 0;
  if (missing === 0) return null;

  // Older payloads carry only the combined count. Attributing all of it to a
  // missing rate is the bug this split exists to fix, so with nothing better to
  // go on, say the neutral thing.
  const hasBreakdown =
    data.unrated_calls !== undefined && data.no_usage_calls !== undefined;
  const unrated = hasBreakdown ? Number(data.unrated_calls) || 0 : 0;
  const noUsage = hasBreakdown ? Number(data.no_usage_calls) || 0 : 0;

  const pct = Math.round((Number(data.priced_share) || 0) * 100);
  const parts = [
    `This total covers ${pct}% of recorded calls — ${missing} of ${data.total_calls} contributed nothing to it, so the real figure is higher.`
  ];

  if (!hasBreakdown) {
    parts.push(`${missing} had no cost recorded.`);
  } else {
    if (unrated > 0) {
      parts.push(
        `${unrated} had no pricing entry for their model; add rates to ~/.orangebox/pricing.json to close that part.`
      );
    }
    if (noUsage > 0) {
      parts.push(
        `${noUsage} never reported token counts — errored, aborted, or streamed without usage — so their cost is unknowable, not missing.`
      );
    }
  }

  return parts.join(' ');
}

/**
 * What clicking a row should filter the runs list down to.
 *
 * A dashboard that tells you where the money went and then cannot show you the
 * calls is half a tool — you learn that opus cost the most and the trail stops.
 * Returned as plain filter data so the caller owns navigation and this stays
 * testable.
 *
 * The rollup row is deliberately not drillable: "+4 more" is several keys at
 * once and there is no single filter that means it.
 */
export function drilldownFor(groupBy, group) {
  if (!group || group.rollup) return null;
  const key = String(group.key ?? '');
  if (key === '') return null;

  switch (groupBy) {
    case 'model':
      return { model: key };
    case 'provider':
      return { provider: key };
    case 'run':
      // The group key is the run's name, or its id when it has no name. Search
      // matches both, so one filter covers either case.
      return { search: key };
    case 'day': {
      // A local calendar day, as the grouping computed it. The runs filter
      // takes dates, so the day is both ends of the range.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
      return { from: key, to: key };
    }
    default:
      return null;
  }
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

function table(groups, onDrill) {
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
    if (g.unrated_calls > 0) {
      flags.push(
        el('span', {
          class: 'spend-flag',
          title: `${g.unrated_calls} of ${g.calls} calls have no pricing entry for this model, so this row is an under-estimate. Adding a rate to pricing.json fixes it.`,
          text: ` ${g.unrated_calls} unrated`
        })
      );
    }
    if (g.no_usage_calls > 0) {
      flags.push(
        el('span', {
          class: 'spend-flag muted',
          title: `${g.no_usage_calls} of ${g.calls} calls reported no token counts — errored, aborted, or streamed without usage. Their cost cannot be known, and no pricing entry would change that.`,
          text: ` ${g.no_usage_calls} no usage`
        })
      );
    }
    // Older payloads only carry the combined count; say the neutral thing.
    if (g.unrated_calls === undefined && g.unpriced_calls > 0) {
      flags.push(
        el('span', {
          class: 'spend-flag',
          title: `${g.unpriced_calls} of ${g.calls} calls have no cost recorded, so this row is an under-estimate`,
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

    const drill = onDrill ? drilldownFor(state.group, g) : null;

    return el('tr', {
      class: [g.rollup ? 'rollup' : null, drill ? 'drillable' : null].filter(Boolean).join(' ') || null,
      // A row that navigates is a control, so it has to be reachable and
      // announced as one — a click handler on a bare <tr> is invisible to
      // anyone not using a mouse.
      tabindex: drill ? '0' : null,
      role: drill ? 'button' : null,
      title: drill ? `Show runs using ${g.key}` : null,
      on: drill
        ? {
            click: () => onDrill(drill),
            keydown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onDrill(drill);
              }
            }
          }
        : null
    }, [
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
export function renderSpend(host, onChange, onDrill) {
  const body = el('div', { class: 'spend' });

  body.append(
    el('div', { class: 'spend-controls' }, [
      el('span', { class: 'spend-ctl-label', text: 'group by' }),
      segmented({ options: GROUPS, current: state.group, label: 'Group spend by', onPick: (v) => { state.group = v; onChange(); } }),
      el('span', { class: 'spend-ctl-gap' }),
      el('span', { class: 'spend-ctl-label', text: 'window' }),
      segmented({ options: WINDOWS, current: state.days, label: 'Time window', onPick: (v) => { state.days = v; onChange(); } })
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
    body.append(chart(groups), table(groups, onDrill));
  }

  host.replaceChildren(body);
}
