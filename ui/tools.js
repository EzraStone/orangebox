// §19.8 — tool behaviour across runs, as a view.
//
// Same shape as spend.js: pure functions first so the arithmetic is testable
// in node, DOM rendering after. The recurring theme is the same too — say how
// much of the number is real, rather than presenting a confident average built
// from two samples.

import { el, fmt } from './dom.js';

export const WINDOWS = [
  ['', 'All time'],
  ['1', '24 hours'],
  ['7', '7 days'],
  ['30', '30 days']
];

export const SORTS = [
  ['uses', 'Most used'],
  ['errors', 'Most errors'],
  ['slow', 'Slowest'],
  ['unanswered', 'Unanswered']
];

/**
 * Order the rows. Sorting by a field that is null for some tools has to put
 * those last rather than treating null as zero — a tool with no timing is
 * unknown, not instant.
 */
export function sortTools(tools, by = 'uses') {
  const rows = [...(tools ?? [])];
  const nullsLast = (a, b, pick) => {
    const x = pick(a);
    const y = pick(b);
    if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
    if (y === null || y === undefined) return -1;
    return y - x;
  };

  switch (by) {
    case 'errors':
      return rows.sort((a, b) => b.errors - a.errors || b.uses - a.uses);
    case 'unanswered':
      return rows.sort((a, b) => b.unanswered - a.unanswered || b.uses - a.uses);
    case 'slow':
      return rows.sort((a, b) => nullsLast(a, b, (t) => t.avg_ms) || b.uses - a.uses);
    default:
      return rows.sort((a, b) => b.uses - a.uses || String(a.key).localeCompare(String(b.key)));
  }
}

/**
 * How confident the timing on a row is. Returned as data so the renderer and a
 * test agree on when a number deserves a caveat.
 */
export function timingConfidence(tool) {
  if (!tool || tool.avg_ms === null || tool.avg_ms === undefined) {
    return { known: false, note: 'never used alone, so no gap belongs to it' };
  }
  if (tool.timed_uses < tool.uses) {
    return { known: true, partial: true, note: `timed on ${tool.timed_uses} of ${tool.uses} uses` };
  }
  return { known: true, partial: false, note: null };
}

/** A one-line summary of what the whole window contains. */
export function headline(data) {
  if (!data || data.total_uses === 0) return null;
  const parts = [`${data.total_uses} tool call${data.total_uses === 1 ? '' : 's'}`];
  if (data.total_errors > 0) parts.push(`${data.total_errors} errored`);
  if (data.total_unanswered > 0) parts.push(`${data.total_unanswered} never answered`);
  return parts.join(' · ');
}

// =========================================================== rendering

export const state = { days: '', sort: 'uses', data: null, loading: false, error: null };

export async function loadTools(get) {
  state.loading = true;
  state.error = null;
  try {
    const params = new URLSearchParams();
    if (state.days) params.set('since', String(Date.now() - Number(state.days) * 86_400_000));
    state.data = await get(`/api/tools?${params}`);
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

function table(tools, onDrill) {
  const head = el('tr', {}, [
    el('th', { scope: 'col', text: 'Tool' }),
    el('th', { scope: 'col', class: 'num', text: 'Uses' }),
    el('th', { scope: 'col', class: 'num', text: 'Runs' }),
    el('th', { scope: 'col', class: 'num', text: 'Errors' }),
    el('th', { scope: 'col', class: 'num', text: 'Avg' }),
    el('th', { scope: 'col', class: 'num', text: 'Slowest' })
  ]);

  const rows = tools.map((tool) => {
    const confidence = timingConfidence(tool);
    const flags = [];

    if (tool.unanswered > 0) {
      flags.push(
        el('span', {
          class: 'spend-flag',
          title:
            `${tool.unanswered} of ${tool.uses} calls to this tool never got a result back — ` +
            'a broken agent loop, a crash, or a run that ended mid-turn.',
          text: ` ${tool.unanswered} unanswered`
        })
      );
    }
    if (confidence.partial) {
      flags.push(
        el('span', {
          class: 'spend-flag muted',
          title:
            'Timing comes from the gap between two calls. When a call requests several tools ' +
            'that gap covers all of them, so only single-tool calls are measured.',
          text: ` ${confidence.note}`
        })
      );
    }

    return el('tr', {
      class: onDrill ? 'drillable' : null,
      tabindex: onDrill ? '0' : null,
      role: onDrill ? 'button' : null,
      title: onDrill ? `Show runs that used ${tool.key}` : null,
      on: onDrill
        ? {
            click: () => onDrill({ tool: tool.key }),
            keydown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onDrill({ tool: tool.key });
              }
            }
          }
        : null
    }, [
      el('td', {}, [el('span', { class: 'spend-key', text: String(tool.key) }), ...flags]),
      el('td', { class: 'num', text: String(tool.uses) }),
      el('td', { class: 'num', text: String(tool.runs) }),
      el('td', {
        class: tool.errors > 0 ? 'num err' : 'num',
        text: tool.errors > 0 ? `${tool.errors} (${Math.round(tool.error_rate * 100)}%)` : '0'
      }),
      el('td', {
        class: 'num',
        title: confidence.known ? '' : confidence.note,
        text: confidence.known ? fmt.ms(tool.avg_ms) : '—'
      }),
      el('td', { class: 'num', text: tool.slowest_ms === null ? '—' : fmt.ms(tool.slowest_ms) })
    ]);
  });

  return el('table', { class: 'spend-table' }, [el('thead', {}, [head]), el('tbody', {}, rows)]);
}

export function renderTools(host, onChange, onDrill) {
  const body = el('div', { class: 'spend' });

  body.append(
    el('div', { class: 'spend-controls' }, [
      el('span', { class: 'spend-ctl-label', text: 'sort' }),
      segmented(SORTS, state.sort, (v) => (state.sort = v), onChange, 'Sort tools by'),
      el('span', { class: 'spend-ctl-gap' }),
      el('span', { class: 'spend-ctl-label', text: 'window' }),
      segmented(WINDOWS, state.days, (v) => (state.days = v), onChange, 'Time window')
    ])
  );

  const data = state.data;

  if (state.error) {
    body.append(el('p', { class: 'spend-note', text: `Could not load tools: ${state.error}` }));
  } else if (state.loading && !data) {
    body.append(el('p', { class: 'spend-note', text: 'Loading…' }));
  } else if (!data || data.total_uses === 0) {
    body.append(
      el('p', {
        class: 'spend-note',
        text: 'No tool calls recorded in this window. Tool use shows up here once an agent starts calling them.'
      })
    );
  } else {
    body.append(
      el('div', { class: 'spend-total' }, [
        el('span', { class: 'spend-total-value', text: String(data.total_uses) }),
        el('span', { class: 'spend-total-sub', text: headline(data) })
      ])
    );

    if (data.total_unanswered > 0) {
      body.append(
        el('div', { class: 'banner spend-banner', role: 'status' }, [
          el('span', {
            text:
              `${data.total_unanswered} tool call${data.total_unanswered === 1 ? '' : 's'} never got a result back. ` +
              'That is the agent loop breaking, a crash, or a run ending mid-turn — not a slow tool.'
          })
        ])
      );
    }

    body.append(table(sortTools(data.tools, state.sort), onDrill));
  }

  host.replaceChildren(body);
}
