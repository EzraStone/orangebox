// §11 — the handful of helpers every view needs: build an element, find one by
// id, format a number the way a human reads it.
//
// These lived at the top of app.js until there was a second view. Nothing here
// knows about runs, calls or spend; that is the whole point.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Tags that must be created in the SVG namespace. createElement('rect') makes
// an HTMLUnknownElement that lays out as nothing and silently draws nothing,
// which is a maddening bug to look at — the shape is in the DOM, sized, and
// invisible.
const SVG_TAGS = new Set([
  'svg', 'g', 'rect', 'circle', 'line', 'path', 'text', 'tspan',
  'polyline', 'polygon', 'defs', 'title', 'ellipse'
]);

/**
 * Build an element. Children are strings (inserted as text, never markup) or
 * nodes. Recorded content is untrusted: a prompt containing markup has to
 * render inert (§12.3), so there is deliberately no innerHTML path here.
 */
export function el(tag, props = {}, children = []) {
  const isSvg = SVG_TAGS.has(tag);
  const node = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    // className is read-only-ish on SVG elements (it is an SVGAnimatedString),
    // so class always goes through setAttribute for those.
    if (key === 'class') {
      if (isSvg) node.setAttribute('class', value);
      else node.className = value;
    } else if (key === 'text') node.textContent = value;
    else if (key === 'on') for (const [ev, fn] of Object.entries(value)) node.addEventListener(ev, fn);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
  return node;
}

export const $ = (id) => document.getElementById(id);

/**
 * Human formatting. Every one of these returns an em-dash for null rather than
 * a zero: "orangebox does not know" and "the answer is zero" are different
 * claims, and collapsing them is how a dashboard starts lying (§08).
 */
export const fmt = {
  ms(v) {
    if (v === null || v === undefined) return '—';
    if (v < 1000) return `${Math.round(v)} ms`;
    if (v < 60_000) return `${(v / 1000).toFixed(1)} s`;
    const m = Math.floor(v / 60_000);
    return `${m}m ${Math.round((v % 60_000) / 1000)}s`;
  },
  // Must match formatTokens in src/format.mjs exactly — this file cannot
  // import it (ui/ is served as static assets, with no build step), so a test
  // checks the two against each other across a table of values. Before that,
  // 24,500 tokens read as "24.5k" in the terminal and "25k" here.
  tokens(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    if (v < 10_000) return String(v);
    if (v < 999_500) return `${(v / 1000).toFixed(v < 100_000 ? 1 : 0)}k`;
    return `${(v / 1_000_000).toFixed(1)}M`;
  },
  // Must match formatUsd in src/format.mjs — same reason as tokens above.
  usd(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    if (v === 0) return '$0';
    if (v < 0.01) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(v < 1 ? 3 : 2)}`;
  },
  when(ts) {
    if (!ts) return '';
    const delta = Date.now() - ts;
    if (delta < 60_000) return 'just now';
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    if (delta < 86_400_000) return `${p(d.getHours())}:${p(d.getMinutes())}`;
    if (delta < 172_800_000) return 'yesterday';
    return `${d.getMonth() + 1}/${d.getDate()}`;
  },
  clock(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  },
  json(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
};

/**
 * §11 — every keyboard shortcut, in one place.
 *
 * Exported as data so the overlay and a test read the same list. The app grew
 * eight shortcuts with no way to discover any of them; a binding nobody knows
 * about is a binding that does not exist.
 */
export const SHORTCUTS = [
  { keys: ['j'], label: 'Next call' },
  { keys: ['k'], label: 'Previous call' },
  { keys: ['Enter'], label: 'Open the selected call' },
  { keys: ['g'], label: 'Jump to the newest call and follow live' },
  { keys: ['/'], label: 'Search recorded prompts and responses' },
  { keys: ['$'], label: 'Spend across runs' },
  { keys: ['t'], label: 'Tool usage across runs' },
  { keys: ['e'], label: 'Failures across runs' },
  { keys: [String.fromCharCode(92)], label: 'Show or hide the runs pane' },
  { keys: ['?'], label: 'This list' },
  { keys: ['Esc'], label: 'Close whatever is open' }
];

/**
 * The time windows every cross-run view offers. One list, because three views
 * each defining their own drifted immediately — spend had "24 hours" where
 * tools had "Last 24 hours", for no reason anyone chose.
 */
export const WINDOWS = [
  ['', 'All time'],
  ['1', '24 hours'],
  ['7', '7 days'],
  ['30', '30 days']
];

/**
 * A row of mutually exclusive buttons.
 *
 * `aria-pressed` rather than a class, so the current choice is announced
 * rather than only coloured; the label names the group for anyone arriving
 * without seeing the text beside it.
 */
export function segmented({ options, current, onPick, label }) {
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
            if (current === value) return; // re-picking the current filter is a no-op
            onPick(value);
          }
        }
      })
    );
  }
  return wrap;
}

/**
 * Call `fn` at most once every `ms`, and never drop the last call.
 *
 * The timeline re-renders on every completed call, which is right for the
 * calls themselves and wrong for the two banners above them: each one asks the
 * server to re-analyse the entire run. On a two-hundred-call run that is four
 * hundred requests, each doing more work than the last, to redraw a sentence
 * that barely changes.
 *
 * Leading edge so the first render is immediate, trailing edge so the banner
 * ends up describing the run as it finally was rather than as it was three
 * seconds before the end.
 */
export function throttled(ms, fn) {
  let last = -Infinity;
  let timer = null;
  let queued = null;

  return (...args) => {
    const now = Date.now();
    const wait = ms - (now - last);

    if (wait <= 0) {
      last = now;
      queued = null;
      return void fn(...args);
    }

    // Only the most recent arguments matter; this is a redraw, not a queue.
    queued = args;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      last = Date.now();
      const next = queued;
      queued = null;
      if (next) fn(...next);
    }, wait);
  };
}

/**
 * What kind of stop a provider's stop reason is, whatever the provider.
 *
 * The timeline used to recognise Anthropic's spelling only, so an OpenAI
 * response cut off with `length`, or a Gemini one with `MAX_TOKENS`, drew as an
 * ordinary finish — the one warning chip that matters, missing for three of
 * the five providers.
 *
 * TRUNCATED_STOPS must equal every entry in TRUNCATION_REASONS in
 * src/truncation.mjs. This file cannot import that one (ui/ is static assets
 * with no build step), so a test checks the two agree.
 */
export const TRUNCATED_STOPS = new Set(['max_tokens', 'length', 'max_output_tokens', 'MAX_TOKENS']);
export const TOOL_STOPS = new Set(['tool_use', 'tool_calls']);

export function stopKind(reason) {
  if (typeof reason !== 'string' || reason === '') return '';
  if (TRUNCATED_STOPS.has(reason)) return 'truncated';
  if (TOOL_STOPS.has(reason)) return 'tool';
  return '';
}
