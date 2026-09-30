// §30 — every check orangebox makes, across runs, as a view.
//
// Each of the three banners on a run's timeline answers a question you only
// ask once you are already looking at that run. This one answers the question
// you have first: which runs need looking at, and why.

import { el, segmented, WINDOWS, fmt } from './dom.js';

export const FINDING_LABELS = {
  truncated: 'Cut off',
  loop: 'Looping',
  growth: 'Runaway context'
};

/**
 * One sentence for the window. "Nothing wrong" is said outright rather than
 * drawn as an empty list, because an empty list looks like a loading state.
 */
export function diagnosisSummary(data) {
  if (!data || data.checked_runs === 0) return 'No runs recorded in this window.';
  if (data.flagged_runs === 0) {
    return `Nothing wrong found in ${data.checked_runs} run${data.checked_runs === 1 ? '' : 's'}.`;
  }

  const parts = [];
  const { truncated = 0, loop = 0, growth = 0 } = data.counts ?? {};
  if (truncated) parts.push(`${truncated} with cut-off answers`);
  if (loop) parts.push(`${loop} looping`);
  if (growth) parts.push(`${growth} with runaway context`);

  return `${data.flagged_runs} of ${data.checked_runs} runs need a look — ${parts.join(', ')}.`;
}

export const state = { days: '7', data: null, loading: false, error: null };

export async function loadDiagnosis(get) {
  state.loading = true;
  state.error = null;
  try {
    const params = new URLSearchParams();
    if (state.days) params.set('since', String(Date.now() - Number(state.days) * 86_400_000));
    state.data = await get(`/api/diagnosis?${params}`);
  } catch (err) {
    state.data = null;
    state.error = String(err?.message ?? err);
  } finally {
    state.loading = false;
  }
}

function runRow(entry, onOpen) {
  const open = () => onOpen(entry);
  return el('li', {
    class: 'diag-row',
    tabindex: '0',
    role: 'button',
    title: `Open ${entry.run.name ?? entry.run.id}`,
    on: {
      click: open,
      keydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }
    }
  }, [
    el('div', { class: 'diag-head' }, [
      el('span', { class: 'diag-name', text: entry.run.name ?? entry.run.id }),
      el('span', { class: 'diag-when', text: fmt.when(entry.run.started_at) })
    ]),
    el('ul', { class: 'diag-findings' }, entry.findings.map((finding) =>
      el('li', { class: `diag-finding diag-${finding.kind}` }, [
        el('span', { class: 'diag-kind', text: FINDING_LABELS[finding.kind] ?? finding.kind }),
        el('span', { class: 'diag-text', text: finding.text }),
        // A finding that points at a call opens onto it. Its own button, not
        // a click target inside the row's: nested interactive elements are
        // announced as one and cannot be told apart by keyboard.
        finding.call_id
          ? el('button', {
              class: 'diag-open', type: 'button', text: 'show call',
              'aria-label': `Show the call behind: ${finding.text}`,
              on: { click: (event) => { event.stopPropagation(); onOpen(entry, finding.call_id); } }
            })
          : null
      ])
    ))
  ]);
}

export function renderDiagnosis(host, onChange, onOpen) {
  const body = el('div', { class: 'spend' });

  body.append(
    el('div', { class: 'spend-controls' }, [
      el('span', { class: 'spend-ctl-label', text: 'window' }),
      segmented({
        options: WINDOWS,
        current: state.days,
        label: 'Time window',
        onPick: (value) => { state.days = value; onChange(); }
      })
    ])
  );

  if (state.error) {
    body.append(el('p', { class: 'spend-note', text: `Could not run the checks: ${state.error}` }));
  } else if (state.loading && !state.data) {
    body.append(el('p', { class: 'spend-note', text: 'Checking…' }));
  } else {
    body.append(el('p', { class: 'spend-note', text: diagnosisSummary(state.data) }));
    if (state.data?.runs?.length) {
      body.append(el('ul', { class: 'diag-list' }, state.data.runs.map((entry) => runRow(entry, onOpen))));
    }
  }

  host.replaceChildren(body);
}
