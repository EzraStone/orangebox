// §19.9 — search inside recorded prompts and responses, as a view.
//
// The snippets here are the one place orangebox renders a fragment of a
// recorded payload outside the detail pane, so everything goes in as text
// (§12.3). A prompt containing markup renders inert, and the highlight is
// built by splitting the string rather than by injecting tags around it.

import { el, fmt } from './dom.js';

/**
 * Split `text` into alternating plain and matching parts.
 *
 * Returned as data so the renderer can build elements from it, rather than
 * assembling a string of HTML — which is how a recorded prompt would end up
 * being parsed as markup.
 */
export function splitOnMatch(text, needle) {
  const haystack = String(text ?? '');
  const query = String(needle ?? '');
  if (query === '' || haystack === '') return [{ text: haystack, match: false }];

  const parts = [];
  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = query.toLowerCase();
  let from = 0;

  for (;;) {
    const at = lowerHay.indexOf(lowerNeedle, from);
    if (at === -1) break;
    if (at > from) parts.push({ text: haystack.slice(from, at), match: false });
    parts.push({ text: haystack.slice(at, at + query.length), match: true });
    from = at + query.length;
  }

  if (from < haystack.length) parts.push({ text: haystack.slice(from), match: false });
  return parts.length ? parts : [{ text: haystack, match: false }];
}

/** JSON blobs arrive full of newlines and padding; one line reads better. */
export function collapse(text) {
  const whitespace = new RegExp(String.fromCharCode(92) + 's+', 'g');
  return String(text ?? '').replace(whitespace, ' ').trim();
}

/** What to say about a result set, including when it is truncated. */
export function resultSummary(data) {
  if (!data || !data.query) return null;
  if (data.total === 0) return `Nothing recorded contains “${data.query}”.`;
  const capped = data.limit !== undefined && data.total >= data.limit;
  return `${data.total} match${data.total === 1 ? '' : 'es'}${capped ? ` (showing the newest ${data.limit})` : ''}`;
}

export const state = { query: '', data: null, loading: false, error: null };

export async function loadFind(get) {
  const query = state.query.trim();
  if (query === '') {
    state.data = null;
    state.error = null;
    return;
  }

  state.loading = true;
  state.error = null;
  try {
    state.data = await get(`/api/search?q=${encodeURIComponent(query)}&limit=50`);
  } catch (err) {
    state.data = null;
    state.error = String(err?.message ?? err);
  } finally {
    state.loading = false;
  }
}

// =========================================================== rendering

function snippet(text, query) {
  const line = el('div', { class: 'find-snippet' });
  for (const part of splitOnMatch(collapse(text), query)) {
    line.append(part.match ? el('mark', { text: part.text }) : document.createTextNode(part.text));
  }
  return line;
}

function resultRow(hit, query, onOpen) {
  const meta = [
    hit.model ?? 'no model',
    hit.where === 'both' ? 'prompt and response' : hit.where,
    fmt.when(hit.started_at)
  ];
  if (hit.error_type) meta.push(hit.error_type);

  return el('li', {
    class: 'find-hit',
    tabindex: '0',
    role: 'button',
    title: `Open call ${hit.seq} in ${hit.run_name}`,
    on: {
      click: () => onOpen(hit),
      keydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(hit);
        }
      }
    }
  }, [
    el('div', { class: 'find-hit-head' }, [
      el('span', { class: 'find-run', text: hit.run_name }),
      el('span', { class: 'find-sep', text: '·' }),
      el('span', { class: 'find-call', text: `call ${String(hit.seq).padStart(2, '0')}` }),
      el('span', { class: 'find-meta', text: meta.join(' · ') })
    ]),
    snippet(hit.snippet ?? '', query)
  ]);
}

export function renderFind(host, { onSearch, onOpen }) {
  const body = el('div', { class: 'spend find' });

  const input = el('input', {
    id: 'find-input',
    class: 'find-input',
    type: 'search',
    placeholder: 'Search inside prompts and responses',
    'aria-label': 'Search recorded content',
    value: state.query
  });
  input.addEventListener('input', () => {
    state.query = input.value;
    onSearch();
  });

  body.append(el('div', { class: 'spend-controls' }, [input]));

  if (state.error) {
    body.append(el('p', { class: 'spend-note', text: `Search failed: ${state.error}` }));
  } else if (state.query.trim() === '') {
    body.append(
      el('p', {
        class: 'spend-note',
        text: 'Type to search every recorded prompt and response. Run names and tags are searched by the box in the runs pane; this one reads the payloads.'
      })
    );
  } else if (state.loading && !state.data) {
    body.append(el('p', { class: 'spend-note', text: 'Searching…' }));
  } else if (state.data) {
    body.append(el('p', { class: 'spend-note', text: resultSummary(state.data) }));
    if (state.data.total > 0) {
      body.append(
        el('ul', { class: 'find-list' },
          state.data.results.map((hit) => resultRow(hit, state.data.query, onOpen)))
      );
    }
  }

  host.replaceChildren(body);

  // Keep the caret where it was: re-rendering on every keystroke would
  // otherwise send focus back to the top of the pane mid-word.
  const live = host.querySelector('#find-input');
  if (live && document.activeElement !== live) {
    const end = live.value.length;
    live.focus();
    live.setSelectionRange(end, end);
  }
}
