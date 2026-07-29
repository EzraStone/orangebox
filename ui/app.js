// §11 — the web UI. Vanilla ES modules, no framework, no build step, no
// third-party anything. Every piece of recorded content is inserted with
// textContent; a prompt containing markup renders inert (§12.3).
import { diffLines, collapseUnchanged, diffStats } from '/diff.js';

// ============================================================ dom helpers

/** Build an element. Children are strings (auto-escaped as text) or nodes. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
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

const $ = (id) => document.getElementById(id);

// ============================================================= formatting

const fmt = {
  ms(v) {
    if (v === null || v === undefined) return '—';
    if (v < 1000) return `${Math.round(v)} ms`;
    if (v < 60_000) return `${(v / 1000).toFixed(1)} s`;
    const m = Math.floor(v / 60_000);
    return `${m}m ${Math.round((v % 60_000) / 1000)}s`;
  },
  tokens(v) {
    if (v === null || v === undefined) return '—';
    if (v < 1000) return String(v);
    return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  },
  usd(v) {
    if (v === null || v === undefined) return '—';
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

// ================================================================== state

const state = {
  runs: [],
  runId: null,
  run: null,
  calls: [],
  tools: [],
  callId: null,
  call: null, // full row, lazily fetched
  tab: 'conversation',
  follow: true,
  online: true,
  // §21.3 diff: which call we are comparing against, and on which side.
  diff: { runId: null, callId: null, side: 'request', runCalls: null, runCallsFor: null, call: null, busy: false }
};

function resetDiff() {
  state.diff = {
    runId: null,
    callId: null,
    side: state.diff?.side ?? 'request',
    runCalls: null,
    runCallsFor: null,
    call: null,
    busy: false
  };
}

const api = {
  async get(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return res.json();
  },
  async send(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return res.json();
  }
};

// ================================================================= router

function pathRunId() {
  const m = location.pathname.match(/^\/run\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function navigate(runId, { replace = false } = {}) {
  const url = runId ? `/run/${encodeURIComponent(runId)}` : '/';
  if (location.pathname !== url) history[replace ? 'replaceState' : 'pushState']({}, '', url);
  selectRun(runId, { fromNav: true });
}

window.addEventListener('popstate', () => selectRun(pathRunId(), { fromNav: true }));

// ============================================================== data load

async function loadRuns() {
  const { runs } = await api.get('/api/runs?limit=200');
  state.runs = runs;
  renderRuns();

  // Nothing selected yet: land on the newest run, or the empty state.
  if (!state.runId && runs.length > 0 && !pathRunId()) {
    navigate(runs[0].id, { replace: true });
  } else if (runs.length === 0) {
    renderTimeline();
  }
}

async function loadRun(runId) {
  if (!runId) {
    state.run = null;
    state.calls = [];
    state.tools = [];
    renderTimeline();
    return;
  }
  try {
    const data = await api.get(`/api/runs/${encodeURIComponent(runId)}`);
    if (state.runId !== runId) return; // a newer selection won
    state.run = data.run;
    state.calls = data.calls;
    state.tools = data.tools;
  } catch {
    state.run = null;
    state.calls = [];
    state.tools = [];
  }
  renderTimeline();
  if (state.follow) scrollToLive();
}

function selectRun(runId, { fromNav = false } = {}) {
  if (state.runId === runId && fromNav) return;
  state.runId = runId;
  state.callId = null;
  state.call = null;
  state.follow = true;
  closeDetail();
  renderRuns();
  loadRun(runId);
}

async function selectCall(callId, { open = true } = {}) {
  state.callId = callId;
  resetDiff(); // the baseline is relative to the selected call
  renderTimeline();
  if (!open) return;

  $('shell').classList.add('detail-open');
  state.call = null;
  renderDetail();
  try {
    const { call } = await api.get(`/api/calls/${encodeURIComponent(callId)}`);
    if (state.callId !== callId) return;
    state.call = call;
  } catch {
    state.call = null;
  }
  renderDetail();
  if (state.tab === 'diff') void prepareDiff();
}

function closeDetail() {
  $('shell').classList.remove('detail-open');
  state.call = null;
}

// ============================================================ runs render

function renderRuns() {
  const list = $('runlist');
  list.replaceChildren();
  $('runs-count').textContent = state.runs.length ? `${state.runs.length} runs` : '';

  for (const run of state.runs) {
    const item = el('li', {}, [
      el(
        'button',
        {
          class: 'run',
          type: 'button',
          'aria-current': String(run.id === state.runId),
          on: { click: () => navigate(run.id) }
        },
        [
          el('span', { class: 'run-top' }, [
            el('span', { class: 'run-name', text: run.name || run.id }),
            el('span', { class: 'run-when', text: fmt.when(run.started_at) })
          ]),
          el('span', { class: 'run-meta' }, [
            el('span', { class: 'num', text: `${run.call_count} call${run.call_count === 1 ? '' : 's'}` }),
            el('span', { class: 'num', text: fmt.usd(run.cost_usd) }),
            run.error_count > 0
              ? el('span', { class: 'run-err', text: `▲ ${run.error_count} error${run.error_count === 1 ? '' : 's'}` })
              : null
          ])
        ]
      )
    ]);
    list.append(item);
  }
}

// ======================================================== timeline render

function renderRunHeader() {
  const head = $('run-header');
  head.replaceChildren();
  if (!state.run) return;

  const run = state.run;
  const duration = run.ended_at ? run.ended_at - run.started_at : lastActivity() - run.started_at;

  head.append(
    el('div', { class: 'run-head' }, [el('h1', { text: run.name || run.id })]),
    el('div', { class: 'spacer' }),
    el('div', { class: 'run-stats' }, [
      el('span', { class: 'num', text: `${fmt.tokens(run.input_tokens)} in / ${fmt.tokens(run.output_tokens)} out` }),
      el('span', { class: 'num', title: 'estimated from pricing.json', text: `${fmt.usd(run.cost_usd)} est.` }),
      el('span', { class: 'num', text: fmt.ms(duration) })
    ]),
    el('button', {
      class: 'btn',
      type: 'button',
      text: 'Export',
      on: { click: () => window.open(`/api/export/${encodeURIComponent(run.id)}`, '_blank') }
    }),
    el('button', {
      class: 'btn danger',
      type: 'button',
      text: 'Delete',
      on: { click: () => deleteRun(run) }
    })
  );
}

function lastActivity() {
  const last = state.calls[state.calls.length - 1];
  return last?.ended_at ?? last?.started_at ?? state.run?.started_at ?? Date.now();
}

async function deleteRun(run) {
  if (!confirm(`Delete "${run.name || run.id}" and its ${run.call_count} recorded call(s)?`)) return;
  await api.send('DELETE', `/api/runs/${encodeURIComponent(run.id)}`);
  state.runId = null;
  await loadRuns();
  navigate(state.runs[0]?.id ?? null, { replace: true });
}

function renderTimeline() {
  renderRunHeader();
  const root = $('timeline');
  root.replaceChildren();

  if (state.runs.length === 0) return void root.append(emptyState());
  if (!state.run) return void root.append(el('p', { class: 'note', text: 'Select a run.' }));
  if (state.calls.length === 0) {
    return void root.append(el('p', { class: 'note', text: 'No calls recorded in this run yet.' }));
  }

  const resultsByUseId = new Map();
  for (const t of state.tools) {
    if (t.kind === 'tool_result' && t.tool_use_id) resultsByUseId.set(t.tool_use_id, t);
  }
  const usesByCall = new Map();
  for (const t of state.tools) {
    if (t.kind !== 'tool_use') continue;
    if (!usesByCall.has(t.call_id)) usesByCall.set(t.call_id, []);
    usesByCall.get(t.call_id).push(t);
  }

  state.calls.forEach((call, i) => {
    root.append(callNode(call));

    const next = state.calls[i + 1];
    if (!next) return;

    // The wall-clock hole between two calls is where the client ran its tools.
    // orangebox never sees them execute — only their results — hence "≈".
    const gap = call.ended_at ? next.started_at - call.ended_at : null;
    const uses = usesByCall.get(call.id) ?? [];

    if (uses.length > 0) {
      root.append(
        el('div', { class: 'tooltrack' }, [
          ...uses.map((use) => {
            const result = resultsByUseId.get(use.tool_use_id);
            return el('span', {
              class: `toolchip${result?.is_error ? ' is-error' : ''}`,
              title: use.tool_use_id ?? '',
              text: `${result?.is_error ? '▲ ' : '▪ '}${use.tool_name ?? 'tool'}`
            });
          }),
          gap !== null ? el('span', { class: 'tool-dur', text: `client-side ≈ ${fmt.ms(gap)}` }) : null
        ])
      );
    } else if (gap !== null && gap > 5000) {
      root.append(el('div', { class: 'gapbreak', text: `· · ·  ${fmt.ms(gap)} idle  · · ·` }));
    }
  });
}

function callNode(call) {
  const inFlight = call.ended_at === null;
  const isError = Boolean(call.error_type);
  const classes = ['call', inFlight ? 'in-flight' : '', isError ? 'is-error' : ''].filter(Boolean);

  const chips = [];
  if (call.streamed) chips.push(el('span', { class: 'chip streaming', text: '▮ stream' }));
  if (isError) {
    chips.push(el('span', { class: 'chip stop-error', text: `▲ ${call.error_type}` }));
  } else if (call.stop_reason) {
    const known = ['tool_use', 'max_tokens'].includes(call.stop_reason) ? call.stop_reason : '';
    chips.push(el('span', { class: `chip ${known ? `stop-${known}` : ''}`, text: `stop: ${call.stop_reason}` }));
  }

  const tokens =
    call.input_tokens === null && call.output_tokens === null
      ? '— tok'
      : `${fmt.tokens(call.input_tokens)} in / ${fmt.tokens(call.output_tokens)} out`;

  const cost = el('span', {
    class: 'num',
    title: call.cost_usd === null ? whyNoCost(call) : 'estimated from pricing.json',
    text: call.cost_usd === null ? '—' : `${fmt.usd(call.cost_usd)} est.`
  });

  return el(
    'button',
    {
      class: classes.join(' '),
      type: 'button',
      dataset: { callId: call.id },
      'aria-current': String(call.id === state.callId),
      on: { click: () => selectCall(call.id) }
    },
    [
      el('span', { class: 'call-line1' }, [
        el('span', { class: 'call-seq num', text: `call ${String(call.seq).padStart(2, '0')}` }),
        el('span', { class: 'call-model', text: call.model ?? call.endpoint }),
        el('span', { class: 'num', text: inFlight ? 'in flight' : fmt.ms(call.latency_ms) }),
        ...chips
      ]),
      el('span', { class: 'call-line2' }, [
        el('span', { class: 'num', text: tokens }),
        cost,
        call.ttft_ms !== null ? el('span', { class: 'num', text: `ttft ${fmt.ms(call.ttft_ms)}` }) : null
      ])
    ]
  );
}

/**
 * A missing cost has three quite different causes and the tooltip should say
 * which — "no pricing entry" on a call that simply reported no tokens sends
 * people off editing pricing.json for nothing.
 */
function whyNoCost(call) {
  const noTokens =
    call.input_tokens === null &&
    call.output_tokens === null &&
    call.cache_read_tokens === null &&
    call.cache_write_tokens === null;

  if (noTokens) {
    if (call.streamed && call.provider === 'openai') {
      return 'enable stream_options.include_usage for streamed token counts';
    }
    return 'no token counts on this call';
  }
  return call.model ? `no pricing entry for ${call.model}` : 'no model recorded';
}

function emptyState() {
  const origin = location.origin;
  const lines = `export ANTHROPIC_BASE_URL="${origin}/anthropic"\nexport OPENAI_BASE_URL="${origin}/openai"`;

  const copy = el('button', {
    class: 'btn',
    type: 'button',
    text: 'Copy',
    on: {
      click: async (e) => {
        try {
          await navigator.clipboard.writeText(lines);
          e.target.textContent = 'Copied';
          setTimeout(() => (e.target.textContent = 'Copy'), 1200);
        } catch {
          e.target.textContent = 'Select manually';
        }
      }
    }
  });

  return el('div', { class: 'empty' }, [
    el('h2', { text: 'Nothing recorded yet.' }),
    el('p', { text: 'Point your agent at orangebox and run it. Calls appear here as they happen — no code changes, no account, nothing leaves this machine.' }),
    el('div', { class: 'setup' }, [copy, el('pre', { text: lines })]),
    el('p', { class: 'note', text: 'Works with any language or framework that talks to the Anthropic or OpenAI HTTP APIs. For precise run boundaries, use "orangebox run -- your-command" or send an x-orangebox-run-id header.' })
  ]);
}

// ========================================================== detail render

const TABS = [
  ['conversation', 'Conversation'],
  ['request', 'Request'],
  ['response', 'Response'],
  ['diff', 'Diff'],
  ['timing', 'Timing']
];

function renderDetail() {
  const head = $('detail-head');
  const tabs = $('tabs');
  const panel = $('tabpanel');
  head.replaceChildren();
  tabs.replaceChildren();
  panel.replaceChildren();

  const summary = state.calls.find((c) => c.id === state.callId);
  if (!summary) return;

  head.append(
    el('span', { class: 'pane-title', text: `call ${String(summary.seq).padStart(2, '0')} · ${summary.provider}` }),
    el('div', { class: 'spacer' }),
    el('button', { class: 'btn', type: 'button', text: 'Close  esc', on: { click: closeDetail } })
  );

  for (const [id, label] of TABS) {
    tabs.append(
      el('button', {
        class: 'tab',
        type: 'button',
        role: 'tab',
        'aria-selected': String(state.tab === id),
        text: label,
        on: {
          click: () => {
            state.tab = id;
            renderDetail();
            if (id === 'diff') void prepareDiff();
          }
        }
      })
    );
  }

  if (!state.call) return void panel.append(el('p', { class: 'note', text: 'Loading…' }));

  const call = state.call;
  if (call.truncated) {
    panel.append(
      el('div', {
        class: 'banner',
        text: '▲ Payloads over 2 MB were trimmed before storage. Structure is intact; the longest text was cut.'
      })
    );
  }

  if (state.tab === 'conversation') panel.append(...conversationView(call));
  else if (state.tab === 'request') panel.append(payloadView(call.request_json));
  else if (state.tab === 'response') panel.append(payloadView(call.response_json));
  else if (state.tab === 'diff') panel.append(...diffView(call));
  else panel.append(...timingView(call, summary));
}

function conversationView(call) {
  let request;
  try {
    request = JSON.parse(call.request_json);
  } catch {
    return [el('p', { class: 'note', text: 'Request payload could not be parsed.' })];
  }

  const out = [];

  if (request.system !== undefined && request.system !== null) {
    out.push(messageCard('system', normalizeContent(request.system), { collapsed: true }));
  }
  for (const message of request.messages ?? []) {
    out.push(messageCard(message.role ?? 'user', normalizeContent(message.content), { message }));
  }

  // The model's own turn is the response, not part of the sent history.
  let response = null;
  try {
    response = call.response_json ? JSON.parse(call.response_json) : null;
  } catch {
    response = null;
  }
  if (response) {
    const content = response.content ?? response.choices?.[0]?.message?.content ?? null;
    const toolCalls = response.choices?.[0]?.message?.tool_calls ?? null;
    const parts = normalizeContent(content);
    for (const tc of toolCalls ?? []) {
      parts.push({ type: 'tool_use', name: tc.function?.name, id: tc.id, input: tc.function?.arguments });
    }
    if (parts.length > 0) out.push(messageCard('assistant', parts, { label: 'response' }));
  }

  if (out.length === 0) out.push(el('p', { class: 'note', text: 'No conversation content in this call.' }));
  return out;
}

/** Flatten the several content shapes the two providers use into one list. */
function normalizeContent(content) {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) {
    return content.map((part) =>
      typeof part === 'string' ? { type: 'text', text: part } : (part ?? { type: 'unknown' })
    );
  }
  return [{ type: 'unknown', value: content }];
}

function messageCard(role, parts, { collapsed = false, label = null, message = null } = {}) {
  const body = el('div', {});
  let open = !collapsed;

  const paint = () => {
    body.replaceChildren();
    if (!open) return;
    if (parts.length === 0) body.append(el('div', { class: 'msg-body' }, [el('pre', { class: 'payload', text: '(empty)' })]));
    for (const part of parts) body.append(blockView(part, message));
  };

  const toggle = el(
    'button',
    {
      class: 'msg-head',
      type: 'button',
      'aria-expanded': String(open),
      on: {
        click: (e) => {
          open = !open;
          e.currentTarget.setAttribute('aria-expanded', String(open));
          e.currentTarget.lastChild.textContent = open ? '▾' : '▸';
          paint();
        }
      }
    },
    [
      el('span', { class: `role role-${role}`, text: role }),
      label ? el('span', { text: label }) : null,
      el('span', { class: 'spacer' }),
      el('span', { text: open ? '▾' : '▸' })
    ]
  );

  paint();
  return el('div', { class: 'msg' }, [toggle, body]);
}

function blockView(part, message = null) {
  if (part.type === 'text' || typeof part.text === 'string') {
    return el('div', { class: 'msg-body' }, [clampedPre(part.text ?? '')]);
  }

  if (part.type === 'tool_use') {
    const input = typeof part.input === 'string' ? tryPretty(part.input) : fmt.json(part.input ?? part.input_raw ?? {});
    return el('div', { class: 'msg-body' }, [
      el('div', { class: 'block-card' }, [
        el('div', { class: 'block-card-head' }, [
          el('span', { text: `▪ tool_use  ${part.name ?? ''}` }),
          el('span', { class: 'spacer' }),
          el('span', { text: part.id ?? '' })
        ]),
        clampedPre(input)
      ])
    ]);
  }

  if (part.type === 'tool_result') {
    const inner = normalizeContent(part.content);
    const text = inner.map((p) => p.text ?? fmt.json(p)).join('\n');
    return el('div', { class: 'msg-body' }, [
      el('div', { class: `block-card${part.is_error ? ' is-error' : ''}` }, [
        el('div', { class: 'block-card-head' }, [
          el('span', { text: `${part.is_error ? '▲ tool_result (error)' : '▪ tool_result'}` }),
          el('span', { class: 'spacer' }),
          el('span', { text: part.tool_use_id ?? '' })
        ]),
        clampedPre(text)
      ])
    ]);
  }

  // role:'tool' messages (OpenAI) arrive as a plain string with an id alongside.
  if (message?.role === 'tool') {
    return el('div', { class: 'msg-body' }, [
      el('div', { class: 'block-card' }, [
        el('div', { class: 'block-card-head' }, [
          el('span', { text: '▪ tool_result' }),
          el('span', { class: 'spacer' }),
          el('span', { text: message.tool_call_id ?? '' })
        ]),
        clampedPre(fmt.json(part.value ?? part))
      ])
    ]);
  }

  return el('div', { class: 'msg-body' }, [clampedPre(fmt.json(part.value ?? part))]);
}

/** Long blocks clamp at 20 lines with a "show all" (§11.2). */
function clampedPre(text) {
  const value = typeof text === 'string' ? text : fmt.json(text);
  const pre = el('pre', { class: 'payload', text: value });
  if (value.split('\n').length <= 20 && value.length < 1600) return pre;

  pre.classList.add('clamped');
  const wrap = el('div', {});
  const more = el('button', {
    class: 'showall',
    type: 'button',
    text: 'show all',
    on: {
      click: (e) => {
        pre.classList.remove('clamped');
        e.currentTarget.remove();
      }
    }
  });
  wrap.append(pre, more);
  return wrap;
}

function tryPretty(raw) {
  try {
    return fmt.json(JSON.parse(raw));
  } catch {
    return raw;
  }
}

function payloadView(json) {
  if (!json) return el('p', { class: 'note', text: 'Nothing recorded for this side of the call.' });
  const pretty = tryPretty(json);

  const copy = el('button', {
    class: 'btn',
    type: 'button',
    text: 'Copy JSON',
    on: {
      click: async (e) => {
        try {
          await navigator.clipboard.writeText(pretty);
          e.target.textContent = 'Copied';
          setTimeout(() => (e.target.textContent = 'Copy JSON'), 1200);
        } catch {
          e.target.textContent = 'Copy failed';
        }
      }
    }
  });

  return el('div', {}, [
    el('div', { class: 'legend' }, [copy]),
    el('pre', { class: 'payload', text: pretty })
  ]);
}

// ============================================================== diff view

/** Default baseline: the call before this one, or the same seq in another run. */
function defaultBaselineId(runCalls, runId) {
  if (runId === state.runId) {
    const index = runCalls.findIndex((c) => c.id === state.callId);
    return index > 0 ? runCalls[index - 1].id : null;
  }
  const seq = state.calls.find((c) => c.id === state.callId)?.seq;
  const match = runCalls.find((c) => c.seq === seq) ?? runCalls[runCalls.length - 1];
  return match?.id ?? null;
}

async function prepareDiff() {
  const d = state.diff;
  if (d.busy) return;
  d.busy = true;
  const forCall = state.callId;

  try {
    const runId = d.runId ?? state.runId;
    d.runId = runId;

    if (d.runCallsFor !== runId) {
      d.runCalls =
        runId === state.runId ? state.calls : (await api.get(`/api/runs/${encodeURIComponent(runId)}`)).calls;
      d.runCallsFor = runId;
    }

    if (d.callId === null) d.callId = defaultBaselineId(d.runCalls, runId);

    if (d.callId && d.call?.id !== d.callId) {
      d.call = (await api.get(`/api/calls/${encodeURIComponent(d.callId)}`)).call;
    } else if (!d.callId) {
      d.call = null;
    }
  } catch {
    d.call = null;
  } finally {
    d.busy = false;
  }

  if (state.callId === forCall && state.tab === 'diff') renderDetail();
}

function diffView(call) {
  const d = state.diff;
  const out = [el('div', { class: 'diffbar' }, diffControls())];

  if (d.busy && !d.call) {
    out.push(el('p', { class: 'note', text: 'Loading baseline…' }));
    return out;
  }
  if (!d.callId) {
    out.push(
      el('p', {
        class: 'note',
        text: 'This is the first call in the run, so there is nothing before it to compare against. Pick a baseline above — another call, or the same position in a different run.'
      })
    );
    return out;
  }
  if (!d.call) {
    out.push(el('p', { class: 'note', text: 'Baseline call could not be loaded.' }));
    return out;
  }

  const field = d.side === 'response' ? 'response_json' : 'request_json';
  const baseText = tryPretty(d.call[field] ?? '');
  const thisText = tryPretty(call[field] ?? '');

  if (!d.call[field] && !call[field]) {
    out.push(el('p', { class: 'note', text: `Neither call recorded a ${d.side}.` }));
    return out;
  }

  const ops = diffLines(baseText.split('\n'), thisText.split('\n'));
  const { added, removed, identical } = diffStats(ops);

  const baseSummary = d.runCalls?.find((c) => c.id === d.callId);
  const baseLabel =
    (d.runId === state.runId ? '' : `${runName(d.runId)} · `) +
    `call ${String(baseSummary?.seq ?? '?').padStart(2, '0')}`;

  out.push(
    el('div', { class: 'diffhead' }, [
      el('span', { class: 'diff-from', text: `− ${baseLabel}` }),
      el('span', { class: 'diff-to', text: `+ this call` }),
      el('span', { class: 'spacer' }),
      identical
        ? el('span', { class: 'chip', text: 'identical' })
        : el('span', { class: 'num diff-count', text: `+${added} −${removed} lines` })
    ])
  );

  if (identical) {
    out.push(
      el('p', {
        class: 'note',
        text: `The two ${d.side}s are byte-identical after pretty-printing. If you expected a change, it is not in this payload.`
      })
    );
    return out;
  }

  const body = el('div', { class: 'diff' });
  for (const op of collapseUnchanged(ops)) {
    if (op.t === 'skip') {
      body.append(el('div', { class: 'diff-skip', text: `⋯ ${op.count} unchanged lines` }));
      continue;
    }
    const cls = op.t === '+' ? 'add' : op.t === '-' ? 'del' : 'same';
    body.append(
      el('div', { class: `diff-line ${cls}` }, [
        el('span', { class: 'diff-gutter', text: op.t === '=' ? ' ' : op.t }),
        el('span', { class: 'diff-text', text: op.text })
      ])
    );
  }
  out.push(body);
  return out;
}

function runName(runId) {
  const run = state.runs.find((r) => r.id === runId);
  return run?.name || runId;
}

function diffControls() {
  const d = state.diff;

  const runPicker = el('select', {
    class: 'sel',
    'aria-label': 'Baseline run',
    on: {
      change: (e) => {
        d.runId = e.target.value;
        d.callId = null;
        d.runCallsFor = null;
        d.call = null;
        renderDetail();
        void prepareDiff();
      }
    }
  });
  for (const run of state.runs) {
    runPicker.append(
      el('option', {
        value: run.id,
        selected: run.id === (d.runId ?? state.runId),
        text: run.id === state.runId ? 'this run' : run.name || run.id
      })
    );
  }

  const callPicker = el('select', {
    class: 'sel',
    'aria-label': 'Baseline call',
    on: {
      change: (e) => {
        d.callId = e.target.value;
        d.call = null;
        renderDetail();
        void prepareDiff();
      }
    }
  });
  for (const c of d.runCalls ?? []) {
    if (d.runId === state.runId && c.id === state.callId) continue; // no self-diff
    callPicker.append(
      el('option', {
        value: c.id,
        selected: c.id === d.callId,
        text: `call ${String(c.seq).padStart(2, '0')}  ${c.model ?? c.endpoint}`
      })
    );
  }
  if (callPicker.childElementCount === 0) {
    callPicker.append(el('option', { value: '', text: 'no other calls' }));
    callPicker.setAttribute('disabled', '');
  }

  const sides = el('span', { class: 'segmented' });
  for (const side of ['request', 'response']) {
    sides.append(
      el('button', {
        class: 'seg',
        type: 'button',
        'aria-pressed': String(d.side === side),
        text: side,
        on: {
          click: () => {
            d.side = side;
            renderDetail();
          }
        }
      })
    );
  }

  return [
    el('span', { class: 'diff-label', text: 'compare against' }),
    runPicker,
    callPicker,
    el('span', { class: 'spacer' }),
    sides
  ];
}

function timingView(call, summary) {
  const total = Math.max(1, (call.ended_at ?? Date.now()) - call.started_at);
  const ttft = call.ttft_ms ?? null;
  const queue = ttft === null ? total : Math.min(ttft, total);
  const stream = ttft === null ? 0 : Math.max(0, total - ttft);

  const bar = el('div', { class: 'timingbar' }, [
    el('span', { class: 'seg-queue', style: `flex: ${Math.max(queue, 1)}` }),
    ttft !== null ? el('span', { class: 'seg-stream', style: `flex: ${Math.max(stream, 1)}` }) : null
  ]);

  const legend = el('div', { class: 'legend' }, [
    el('span', {}, [el('i', { class: 'seg-queue', style: 'background:#3a3f47' }), ttft === null ? 'request → response' : 'request → first token']),
    ttft !== null ? el('span', {}, [el('i', { class: 'seg-stream', style: 'background:#ff5a1f' }), 'streaming']) : null
  ]);

  const rows = [
    ['started', `${fmt.clock(call.started_at)}  (${call.started_at})`],
    ['first token', call.first_token_at ? `${fmt.clock(call.first_token_at)}  (${call.first_token_at})` : '—'],
    ['ended', call.ended_at ? `${fmt.clock(call.ended_at)}  (${call.ended_at})` : '—'],
    ['latency', fmt.ms(call.latency_ms)],
    ['ttft', call.ttft_ms === null ? '—' : fmt.ms(call.ttft_ms)],
    ['streamed', call.streamed ? 'yes' : 'no'],
    ['status', call.status ?? '—'],
    ['error', call.error_type ?? 'none'],
    ['endpoint', `${summary.provider}${call.endpoint}`],
    ['call id', call.id]
  ];

  const dl = el('dl', { class: 'kv' });
  for (const [k, v] of rows) dl.append(el('dt', { text: k }), el('dd', { text: String(v) }));

  return [bar, legend, dl];
}

// ============================================================== live feed

let source = null;
let backoff = 1000;

function connectLive() {
  source = new EventSource('/api/live');

  source.addEventListener('open', () => {
    backoff = 1000;
    setOnline(true);
  });

  const refresh = () => {
    loadRuns().catch(() => {});
    if (state.runId) loadRun(state.runId).catch(() => {});
  };

  // The feed is an invalidation hint, not the source of truth (§10.1) — every
  // event just triggers a refetch, so a dropped event costs one stale render.
  for (const name of ['run.created', 'call.started', 'call.first_token', 'call.completed']) {
    source.addEventListener(name, refresh);
  }

  source.addEventListener('error', () => {
    setOnline(false);
    source.close();
    setTimeout(connectLive, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
}

function setOnline(online) {
  state.online = online;
  renderPill();
}

function renderPill() {
  const pill = $('status-pill');
  pill.replaceChildren();

  if (!state.online) {
    pill.hidden = false;
    pill.className = 'pill offline';
    pill.append(el('span', { class: 'dot down' }), el('span', { text: 'offline — reconnecting' }));
    return;
  }
  if (!state.follow && state.runId) {
    pill.hidden = false;
    pill.className = 'pill';
    pill.replaceChildren(
      el('button', {
        type: 'button',
        text: '↓ jump to live',
        on: {
          click: () => {
            state.follow = true;
            scrollToLive();
            renderPill();
          }
        }
      })
    );
    return;
  }
  pill.hidden = true;
}

function scrollToLive() {
  const scroller = $('timeline-scroll');
  scroller.scrollTop = scroller.scrollHeight;
}

$('timeline-scroll').addEventListener('scroll', () => {
  const s = $('timeline-scroll');
  const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 40;
  if (atBottom !== state.follow) {
    state.follow = atBottom;
    renderPill();
  }
});

// =============================================================== keyboard

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (e.key === 'Escape') return void closeDetail();

  const index = state.calls.findIndex((c) => c.id === state.callId);

  if (e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    if (state.calls.length === 0) return;
    const next =
      index === -1
        ? (e.key === 'j' ? 0 : state.calls.length - 1)
        : Math.min(state.calls.length - 1, Math.max(0, index + (e.key === 'j' ? 1 : -1)));
    selectCall(state.calls[next].id, { open: $('shell').classList.contains('detail-open') });
    document.querySelector(`[data-call-id="${CSS.escape(state.calls[next].id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    if (state.callId) selectCall(state.callId);
  } else if (e.key === 'g') {
    state.follow = true;
    scrollToLive();
    renderPill();
  }
});

// ====================================================== resizable drawer

(function makeResizable() {
  const handle = $('drag');
  const shell = $('shell');
  let dragging = false;

  const move = (e) => {
    if (!dragging) return;
    const fromRight = window.innerWidth - e.clientX;
    const width = Math.min(Math.max(fromRight, 320), window.innerWidth - 420);
    shell.style.setProperty('--detail-w', `${width}px`);
  };

  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', () => (dragging = false));
  handle.addEventListener('pointercancel', () => (dragging = false));
})();

// =================================================================== boot

state.runId = pathRunId();
renderPill();
await loadRuns();
if (state.runId) await loadRun(state.runId);
connectLive();
