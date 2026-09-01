// §19.10 — failures across runs, as a view.
//
// The number that matters here is not the count but the share: a page of
// "12" tells you nothing until you know whether that is 12 of 12 or 12 of
// 9,000. So every row leads with a rate and the count sits behind it.

import { el, fmt } from './dom.js';

export const WINDOWS = [
  ['', 'All time'],
  ['1', '24 hours'],
  ['7', '7 days'],
  ['30', '30 days']
];

/** How alarming a share is. Thresholds, not a gradient — a bar chart of error
 *  rates invites comparing failures to each other rather than to zero. */
export function severity(share) {
  if (share >= 0.2) return 'high';
  if (share >= 0.05) return 'medium';
  return 'low';
}

/**
 * A sentence for the whole window. Says "none failed" explicitly rather than
 * rendering an empty list, because an empty list looks like a loading state.
 */
export function summary(data) {
  if (!data || data.total_calls === 0) return 'No calls recorded in this window.';
  if (data.total_errors === 0) return `${data.total_calls} calls, none failed.`;
  const pct = (data.error_rate * 100).toFixed(1);
  return `${data.total_errors} of ${data.total_calls} calls failed (${pct}%)`;
}

/** "3 runs · anthropic, gemini" — the spread of an error, in one line. */
export function spread(error) {
  const parts = [`${error.runs} run${error.runs === 1 ? '' : 's'}`];
  if (error.providers?.length) parts.push(error.providers.join(', '));
  if (error.models > 1) parts.push(`${error.models} models`);
  return parts.join(' · ');
}

export const state = { days: '', data: null, loading: false, error: null };

export async function loadErrors(get) {
  state.loading = true;
  state.error = null;
  try {
    const params = new URLSearchParams();
    if (state.days) params.set('since', String(Date.now() - Number(state.days) * 86_400_000));
    state.data = await get(`/api/errors?${params}`);
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

function errorRow(error, onOpen) {
  return el('li', {
    class: `err-row sev-${severity(error.share)}`,
    tabindex: '0',
    role: 'button',
    title: `Open the most recent ${error.key}`,
    on: {
      click: () => onOpen(error),
      keydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(error);
        }
      }
    }
  }, [
    el('div', { class: 'err-head' }, [
      el('span', { class: 'err-rate', text: `${(error.share * 100).toFixed(1)}%` }),
      el('span', { class: 'err-key', text: error.key }),
      el('span', { class: 'err-count', text: `${error.count} call${error.count === 1 ? '' : 's'}` })
    ]),
    el('div', { class: 'err-meta', text: spread(error) }),
    el('div', {
      class: 'err-meta',
      text: `last ${fmt.when(error.last_seen)} · ${error.latest_model ?? 'no model'}`
    })
  ]);
}

export function renderErrors(host, onChange, onOpen) {
  const body = el('div', { class: 'spend' });

  body.append(
    el('div', { class: 'spend-controls' }, [
      el('span', { class: 'spend-ctl-label', text: 'window' }),
      segmented(WINDOWS, state.days, (v) => (state.days = v), onChange, 'Time window')
    ])
  );

  if (state.error) {
    body.append(el('p', { class: 'spend-note', text: `Could not load errors: ${state.error}` }));
  } else if (state.loading && !state.data) {
    body.append(el('p', { class: 'spend-note', text: 'Loading…' }));
  } else {
    const data = state.data;
    body.append(el('p', { class: 'spend-note', text: summary(data) }));
    if (data && data.total_errors > 0) {
      body.append(
        el('ul', { class: 'err-list' }, data.errors.map((error) => errorRow(error, onOpen)))
      );
    }
  }

  host.replaceChildren(body);
}
