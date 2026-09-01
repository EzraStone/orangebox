// §11 — the web UI. Vanilla ES modules, no framework, no build step, no
// third-party anything. Every piece of recorded content is inserted with
// textContent; a prompt containing markup renders inert (§12.3).
import { diffLines, collapseUnchanged, diffStats } from '/diff.js';
import { el, $, fmt, SHORTCUTS } from '/dom.js';
import { renderSpend, loadSpend } from '/spend.js';
import { renderTools, loadTools } from '/tools.js';
import { renderFind, loadFind, state as findState } from '/find.js';
import { renderErrors, loadErrors } from '/errors.js';

const authToken = new URLSearchParams(location.search).get('token');
let csrfToken = null;

/** The overlay itself. Reuses the modal layer so Escape and click-away work. */
function openShortcutHelp() {
  if (document.querySelector('.shortcut-layer')) return;

  const rows = SHORTCUTS.map((shortcut) =>
    el('div', { class: 'shortcut-row' }, [
      el('span', { class: 'shortcut-keys' }, shortcut.keys.map((key) => el('kbd', { text: key }))),
      el('span', { class: 'shortcut-label', text: shortcut.label })
    ])
  );

  const card = el('section', { class: 'modal-card shortcut-card' }, [
    el('h2', { class: 'modal-title', text: 'Keyboard shortcuts' }),
    el('div', { class: 'shortcut-grid' }, rows),
    el('p', { class: 'note', text: 'Shortcuts are ignored while a text field has focus.' })
  ]);

  const layer = el('div', { class: 'modal-layer shortcut-layer' }, [card]);
  const close = () => {
    document.removeEventListener('keydown', onKey);
    layer.remove();
  };
  const onKey = (event) => {
    if (event.key === 'Escape' || event.key === '?') {
      event.preventDefault();
      close();
    }
  };

  layer.addEventListener('click', (event) => {
    if (event.target === layer) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(layer);
}

function openModal({ title, message = '', fields = [], confirmText = 'Save', danger = false }) {
  return new Promise((resolve) => {
    const form = el('form', { class: 'modal-card' }, [
      el('h2', { text: title }),
      message ? el('p', { class: 'note', text: message }) : null
    ]);
    for (const field of fields) {
      let control;
      if (field.type === 'textarea') {
        control = el('textarea', { name: field.name, rows: field.rows ?? 14 });
      } else if (field.type === 'select') {
        control = el('select', { name: field.name }, field.options.map((option) =>
          el('option', { value: option.value, text: option.label })
        ));
      } else {
        control = el('input', { name: field.name, type: field.type ?? 'text' });
      }
      control.value = field.value ?? '';
      if (field.required) control.required = true;
      form.append(el('label', { class: 'modal-field' }, [el('span', { text: field.label }), control]));
    }
    const cancel = el('button', { class: 'btn', type: 'button', text: 'Cancel' });
    const submit = el('button', {
      class: `btn primary${danger ? ' danger' : ''}`,
      type: 'submit',
      text: confirmText
    });
    form.append(el('div', { class: 'modal-actions' }, [cancel, submit]));
    const layer = el('div', { class: 'modal-layer' }, [form]);
    const finish = (value) => {
      document.removeEventListener('keydown', onKey);
      layer.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') finish(null);
    };
    cancel.addEventListener('click', () => finish(null));
    layer.addEventListener('click', (event) => {
      if (event.target === layer) finish(null);
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      finish(Object.fromEntries(new FormData(form)));
    });
    document.addEventListener('keydown', onKey);
    document.body.append(layer);
    setTimeout(() => form.querySelector('input, textarea, select, button')?.focus(), 0);
  });
}

function showNotice(title, message) {
  return openModal({ title, message, confirmText: 'OK' });
}

// ============================================================= formatting


// ================================================================== state

const state = {
  runs: [],
  runTotal: 0,
  platform: 'unknown',
  readOnly: false,
  mobileAccess: false,
  filters: { search: '', model: '', provider: '', tool: '', error: '', min_latency: '', min_cost: '', from: '', to: '' },
  view: 'runs', // 'runs' | 'spend' | 'tools' | 'find' | 'errors'
  runId: null,
  run: null,
  calls: [],
  tools: [],
  callId: null,
  call: null, // full row, lazily fetched
  tab: 'conversation',
  follow: true,
  online: true,
  inFlight: new Map(),
  comparison: null,
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

/**
 * Turn a failed response into an Error that carries what the server actually
 * said. Throwing "400 /api/calls/x/replay" discards a body whose whole purpose
 * was to explain the failure — the replay endpoint, for one, answers a missing
 * key by naming the environment variables to set.
 */
async function httpError(res, path) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON, or empty. The status and path are all there is.
  }
  const detail = body?.detail ?? body?.error;
  const error = new Error(detail ? String(detail) : `${res.status} ${path}`);
  error.status = res.status;
  error.body = body;
  return error;
}

const api = {
  async get(path) {
    const res = await fetch(path, {
      headers: authToken ? { 'x-orangebox-auth': authToken } : undefined
    });
    if (!res.ok) throw await httpError(res, path);
    return res.json();
  },
  async send(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-orangebox-csrf': csrfToken ?? '',
        ...(authToken ? { 'x-orangebox-auth': authToken } : {})
      },
      body: JSON.stringify(body ?? {})
    });
    if (!res.ok) throw await httpError(res, path);
    return res.json();
  }
};

// ================================================= mobile access + notifications

function formatPairingCode(code) {
  return String(code ?? '').match(/.{1,5}/g)?.join('-') ?? '';
}

async function manageMobileDevices() {
  const card = el('section', { class: 'modal-card' }, [
    el('h2', { text: 'Paired mobile devices' }),
    el('p', { class: 'note', text: 'Mobile sessions can view recordings but cannot edit, replay, delete, clear, or proxy agent traffic.' })
  ]);
  const list = el('div', { class: 'device-list' });
  const code = el('div', { class: 'pairing-code', hidden: true });
  const rotate = el('button', { class: 'btn', type: 'button', text: 'Rotate pairing code' });
  const close = el('button', { class: 'btn primary', type: 'button', text: 'Done' });
  const actions = el('div', { class: 'modal-actions' }, [rotate, close]);
  card.append(list, code, actions);
  const layer = el('div', { class: 'modal-layer' }, [card]);

  const load = async () => {
    const result = await api.get('/api/mobile/sessions');
    list.replaceChildren();
    if (!result.sessions.length) {
      list.append(el('p', { class: 'note', text: 'No devices are paired in this recorder session.' }));
      return;
    }
    for (const session of result.sessions) {
      list.append(el('div', { class: 'device-row' }, [
        el('span', { class: 'device-name', text: session.name }),
        el('span', { class: 'device-meta', text: `Last seen ${fmt.when(session.last_seen_at)} · expires ${new Date(session.expires_at).toLocaleDateString()}` }),
        el('button', {
          class: 'btn danger',
          type: 'button',
          text: 'Revoke',
          on: { click: async () => {
            await api.send('DELETE', `/api/mobile/sessions/${encodeURIComponent(session.id)}`);
            await load();
          } }
        })
      ]));
    }
  };

  const finish = () => layer.remove();
  close.addEventListener('click', finish);
  layer.addEventListener('click', (event) => { if (event.target === layer) finish(); });
  rotate.addEventListener('click', async () => {
    const result = await api.send('POST', '/api/mobile/pair/rotate');
    code.hidden = false;
    code.textContent = formatPairingCode(result.code);
    rotate.textContent = 'Pairing code rotated';
    rotate.disabled = true;
  });
  document.body.append(layer);
  try {
    await load();
  } catch (error) {
    list.replaceChildren(el('p', { class: 'pair-error', text: `Could not load devices: ${error.message}` }));
  }
}

$('mobile-manage').addEventListener('click', () => void manageMobileDevices());

const notificationSetting = 'orangebox.completion-notifications';

function notificationsEnabled() {
  return 'Notification' in window && Notification.permission === 'granted' && localStorage.getItem(notificationSetting) === 'on';
}

function renderNotificationControl() {
  const button = $('notifications');
  button.hidden = !('Notification' in window) || !window.isSecureContext;
  const enabled = notificationsEnabled();
  button.classList.toggle('enabled', enabled);
  button.textContent = enabled ? '✓' : '!';
  button.title = enabled ? 'Disable completion notifications' : 'Enable completion notifications';
  button.setAttribute('aria-label', button.title);
}

$('notifications').addEventListener('click', async () => {
  if (notificationsEnabled()) {
    localStorage.removeItem(notificationSetting);
  } else if (await Notification.requestPermission() === 'granted') {
    localStorage.setItem(notificationSetting, 'on');
  }
  renderNotificationControl();
});

function notifyCallCompleted(update) {
  if (!document.hidden || !notificationsEnabled()) return;
  const run = state.runs.find((candidate) => candidate.id === update?.run_id);
  const notification = new Notification('orangebox recorded a call', {
    body: run?.name || 'Open orangebox to inspect the completed call.',
    icon: '/icon.svg',
    tag: `orangebox-${update?.run_id ?? 'call'}`
  });
  notification.onclick = () => {
    window.focus();
    if (update?.run_id) navigate(update.run_id);
    notification.close();
  };
}

// ================================================================= router

function pathRunId() {
  const m = location.pathname.match(/^\/run\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function navigate(runId, { replace = false } = {}) {
  const url = runId ? `/run/${encodeURIComponent(runId)}` : '/';
  if (location.pathname !== url) history[replace ? 'replaceState' : 'pushState']({}, '', url);
  const loaded = selectRun(runId, { fromNav: true });
  if (window.innerWidth <= 900) setRunsCollapsed(true);
  syncMobileNav();
  return loaded;
}

const SPEND_PATH = '/spend';

const pathIsSpend = () => location.pathname === SPEND_PATH;

const TOOLS_PATH = '/tools';
const FIND_PATH = '/find';
const ERRORS_PATH = '/errors';
const pathIsErrors = () => location.pathname === ERRORS_PATH;

/** §19.10 — failures across runs. */
async function openErrors({ replace = false } = {}) {
  state.view = 'errors';
  if (!pathIsErrors()) history[replace ? 'replaceState' : 'pushState']({}, '', ERRORS_PATH);
  closeDetail();
  renderRuns();
  renderTimeline();
  syncMobileNav();
  await refreshErrors();
}

/** Navigate to whichever run owns a call, then open it. */
async function openCallById(callId) {
  try {
    const { call } = await api.get(`/api/calls/${encodeURIComponent(callId)}`);
    if (!call) return;
    await navigate(call.run_id);
    await selectCall(call.id);
  } catch {
    // The call was deleted between the aggregate and the click.
  }
}

async function refreshErrors() {
  await loadErrors((path) => api.get(path));
  if (state.view === 'errors') renderTimeline();
}
const pathIsFind = () => location.pathname === FIND_PATH;

/** §19.9 — search recorded content. */
async function openFind({ replace = false } = {}) {
  state.view = 'find';
  if (!pathIsFind()) history[replace ? 'replaceState' : 'pushState']({}, '', FIND_PATH);
  closeDetail();
  renderRuns();
  renderTimeline();
  syncMobileNav();
}

let findTimer = null;
function scheduleFind() {
  clearTimeout(findTimer);
  // Debounced: every keystroke otherwise scans every stored prompt.
  findTimer = setTimeout(async () => {
    await loadFind((path) => api.get(path));
    if (state.view === 'find') renderTimeline();
  }, 220);
}
const pathIsTools = () => location.pathname === TOOLS_PATH;

/** §19.8 — the same shape as openSpend, on its own route. */
async function openTools({ replace = false } = {}) {
  state.view = 'tools';
  if (!pathIsTools()) history[replace ? 'replaceState' : 'pushState']({}, '', TOOLS_PATH);
  closeDetail();
  renderRuns();
  renderTimeline();
  syncMobileNav();
  await refreshTools();
}

async function refreshTools() {
  await loadTools((path) => api.get(path));
  if (state.view === 'tools') renderTimeline();
}

/**
 * Spend is a route, not a modal. It survives a reload, the back button does
 * the obvious thing, and "here is where the month went" is a link you can
 * paste at someone.
 */
async function openSpend({ replace = false } = {}) {
  state.view = 'spend';
  if (!pathIsSpend()) history[replace ? 'replaceState' : 'pushState']({}, '', SPEND_PATH);
  closeDetail();
  renderRuns();
  renderTimeline();
  syncMobileNav();
  await refreshSpend();
}

async function refreshSpend() {
  await loadSpend((path) => api.get(path));
  if (state.view === 'spend') renderTimeline();
}

function closeAnalytics() {
  state.view = 'runs';
  // Not navigate(): the run has not changed, so selectRun would early-return
  // and leave the spend view on screen.
  history.pushState({}, '', state.runId ? `/run/${encodeURIComponent(state.runId)}` : '/');
  renderRuns();
  renderTimeline();
  syncMobileNav();
}

window.addEventListener('popstate', () => {
  if (pathIsSpend()) return void openSpend({ replace: true });
  if (pathIsTools()) return void openTools({ replace: true });
  if (pathIsFind()) return void openFind({ replace: true });
  if (pathIsErrors()) return void openErrors({ replace: true });
  state.view = 'runs';
  selectRun(pathRunId(), { fromNav: true });
  renderTimeline();
});

// ============================================================== data load

const RUN_PAGE_SIZE = 100;

async function loadRuns({ append = false } = {}) {
  const params = new URLSearchParams({
    limit: String(RUN_PAGE_SIZE),
    offset: String(append ? state.runs.length : 0)
  });
  for (const [key, value] of Object.entries(state.filters)) if (value) params.set(key, value);
  const { runs, total } = await api.get(`/api/runs?${params}`);
  state.runs = append ? [...state.runs, ...runs] : runs;
  state.runTotal = total;
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
    for (const call of state.inFlight.values()) {
      if (call.run_id === runId && !state.calls.some((saved) => saved.id === call.id)) {
        state.calls.push(call);
      }
    }
    state.calls.sort((a, b) => a.started_at - b.started_at);
    state.calls.forEach((call, index) => {
      if (call.ended_at === null) call.seq = index + 1;
    });
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
  state.comparison = null;
  state.follow = true;
  closeDetail();
  renderRuns();
  return loadRun(runId);
}

async function selectCall(callId, { open = true } = {}) {
  state.callId = callId;
  resetDiff(); // the baseline is relative to the selected call
  renderTimeline();
  if (!open) return;

  $('shell').classList.add('detail-open');
  syncMobileNav();
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
  syncMobileNav();
}

// ============================================================ runs render

function renderRuns() {
  const list = $('runlist');
  list.replaceChildren();
  $('runs-count').textContent = state.runTotal
    ? `${state.runs.length}${state.runs.length < state.runTotal ? `/${state.runTotal}` : ''} runs`
    : '';
  $('runs-more').hidden = state.runs.length >= state.runTotal;

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
          run.tags?.length
            ? el('span', { class: 'run-tags' }, run.tags.map((tag) => el('span', { class: 'tag', text: tag })))
            : null,
          el('span', { class: 'run-meta' }, [
            el('span', { class: 'num', text: `${run.call_count} call${run.call_count === 1 ? '' : 's'}` }),
            el('span', {
              class: 'num',
              title: run.unknown_cost_count ? `${run.unknown_cost_count} call(s) have unknown cost` : '',
              text: `${fmt.usd(run.cost_usd)}${run.unknown_cost_count ? '+' : ''}`
            }),
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

function renderAnalyticsHeader(title) {
  $('run-header').replaceChildren(
    el('span', { class: 'run-head', text: title }),
    el('span', { class: 'spacer' }),
    el('div', { class: 'run-actions' }, [
      el('button', { class: 'btn', type: 'button', text: 'Back to runs', on: { click: closeAnalytics } })
    ])
  );
}

function renderRunHeader() {
  const head = $('run-header');
  head.replaceChildren();
  if (!state.run) return;

  const run = state.run;
  const duration = run.ended_at ? run.ended_at - run.started_at : lastActivity() - run.started_at;
  const actions = [
    !state.readOnly ? el('button', {
      class: 'btn',
      type: 'button',
      text: 'Edit',
      on: { click: () => editRun(run) }
    }) : null,
    el('button', {
      class: 'btn',
      type: 'button',
      text: 'Compare',
      on: { click: () => compareRun(run) }
    }),
    el('button', {
      class: 'btn',
      type: 'button',
      text: 'JSON',
      on: { click: () => openExport(run.id) }
    }),
    el('button', {
      class: 'btn',
      type: 'button',
      text: 'Share',
      title: 'Preview a sanitized, self-contained HTML report',
      on: { click: () => openExport(run.id, { format: 'html', sanitize: 'full' }) }
    }),
    el('button', {
      class: 'btn',
      type: 'button',
      text: 'OTel',
      title: 'Download an OpenTelemetry JSON export',
      on: { click: () => openExport(run.id, { format: 'otel' }) }
    }),
    !state.readOnly ? el('button', {
      class: 'btn danger',
      type: 'button',
      text: 'Delete',
      on: { click: () => deleteRun(run) }
    }) : null
  ];

  head.append(
    el('div', { class: 'run-head' }, [
      el('h1', { text: run.name || run.id }),
      ...(run.tags ?? []).map((tag) => el('span', { class: 'tag', text: tag }))
    ]),
    el('div', { class: 'spacer' }),
    el('div', { class: 'run-stats' }, [
      el('span', { class: 'num', text: `${fmt.tokens(run.input_tokens)} in / ${fmt.tokens(run.output_tokens)} out` }),
      el('span', {
        class: 'num',
        title: run.unknown_cost_count
          ? `${run.unknown_cost_count} call(s) have unknown cost; total is partial`
          : 'estimated from pricing.json',
        text: `${fmt.usd(run.cost_usd)}${run.unknown_cost_count ? '+' : ''} est.${run.unknown_cost_count ? ' partial' : ''}`
      }),
      el('span', { class: 'num', text: fmt.ms(duration) })
    ]),
    el('div', { class: 'run-actions' }, actions)
  );
}

function openExport(runId, options = {}) {
  const params = new URLSearchParams(options);
  if (authToken) params.set('token', authToken);
  const query = params.size ? `?${params}` : '';
  window.open(`/api/export/${encodeURIComponent(runId)}${query}`, '_blank');
}

async function compareRun(run) {
  const suggestions = state.runs
    .filter((candidate) => candidate.id !== run.id)
    .slice(0, 8)
    .map((candidate) => `${candidate.id}  ${candidate.name || ''}`)
    .join('\n');
  const answer = await openModal({
    title: 'Compare runs',
    message: suggestions ? `Recent runs:\n${suggestions}` : 'Enter another run ID.',
    fields: [{ name: 'run', label: 'Baseline run ID or exact name', required: true }],
    confirmText: 'Compare'
  });
  const requested = answer?.run;
  if (!requested) return;
  const match = state.runs.find(
    (candidate) => candidate.id === requested.trim() || candidate.name === requested.trim()
  );
  const otherId = match?.id ?? requested.trim();
  try {
    state.comparison = await api.get(
      `/api/compare?left=${encodeURIComponent(otherId)}&right=${encodeURIComponent(run.id)}`
    );
    renderTimeline();
  } catch {
    await showNotice('Run not found', `Could not find run "${requested.trim()}".`);
  }
}

async function editRun(run) {
  const answer = await openModal({
    title: 'Edit run',
    fields: [
      { name: 'name', label: 'Run name', value: run.name ?? '' },
      { name: 'tags', label: 'Tags (comma-separated)', value: (run.tags ?? []).join(', ') }
    ]
  });
  if (!answer) return;
  const result = await api.send('PATCH', `/api/runs/${encodeURIComponent(run.id)}`, {
    name: answer.name,
    tags: answer.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
  });
  state.run = result.run;
  await loadRuns();
  renderTimeline();
}

function lastActivity() {
  const last = state.calls[state.calls.length - 1];
  return last?.ended_at ?? last?.started_at ?? state.run?.started_at ?? Date.now();
}

async function deleteRun(run) {
  const confirmed = await openModal({
    title: 'Delete run?',
    message: `Delete "${run.name || run.id}" and its ${run.call_count} recorded call(s)? This cannot be undone.`,
    confirmText: 'Delete',
    danger: true
  });
  if (!confirmed) return;
  await api.send('DELETE', `/api/runs/${encodeURIComponent(run.id)}`, {});
  state.runId = null;
  await loadRuns();
  navigate(state.runs[0]?.id ?? null, { replace: true });
}

function renderTimeline() {
  if (state.view === 'errors') {
    renderAnalyticsHeader('Errors');
    return void renderErrors($('timeline'), () => void refreshErrors(), (error) => {
      if (!error.latest_call_id) return;
      closeAnalytics();
      void openCallById(error.latest_call_id);
    });
  }
  if (state.view === 'find') {
    renderAnalyticsHeader('Search');
    return void renderFind($('timeline'), {
      onSearch: scheduleFind,
      onOpen: (hit) => {
        closeAnalytics();
        navigate(hit.run_id)?.then?.(() => selectCall(hit.id));
      }
    });
  }
  if (state.view === 'tools') {
    renderAnalyticsHeader('Tools');
    return void renderTools($('timeline'), () => void refreshTools(), applySpendDrilldown);
  }
  if (state.view === 'spend') {
    renderAnalyticsHeader('Spend');
    return void renderSpend($('timeline'), () => void refreshSpend(), applySpendDrilldown);
  }
  renderRunHeader();
  const root = $('timeline');
  root.replaceChildren();

  if (state.runs.length === 0) return void root.append(emptyState());
  if (!state.run) return void root.append(el('p', { class: 'note', text: 'Select a run.' }));
  if (state.comparison) return void root.append(comparisonView(state.comparison));
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

function comparisonView(comparison) {
  const container = el('section', { class: 'comparison' });
  container.append(
    el('div', { class: 'comparison-head' }, [
      el('div', {}, [el('strong', { text: comparison.left.name || comparison.left.id }), el('span', { text: ' baseline' })]),
      el('div', {}, [el('strong', { text: comparison.right.name || comparison.right.id }), el('span', { text: ' current' })]),
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Close comparison',
        on: { click: () => { state.comparison = null; renderTimeline(); } }
      })
    ])
  );
  for (const pair of comparison.pairs) {
    container.append(el('article', { class: 'compare-row' }, [
      compareSide(pair.left, pair.index),
      compareSide(pair.right, pair.index),
      el('div', { class: 'compare-deltas' }, [
        deltaChip('latency', pair.delta.latency_ms, 'ms'),
        deltaChip('input', pair.delta.input_tokens, ' tok'),
        deltaChip('output', pair.delta.output_tokens, ' tok'),
        deltaChip('cost', pair.delta.cost_usd, '', true),
        pair.delta.model_changed ? el('span', { class: 'chip changed', text: 'model changed' }) : null,
        pair.delta.error_changed ? el('span', { class: 'chip changed', text: 'error changed' }) : null,
        pair.delta.prompt_changed ? el('span', { class: 'chip changed', text: 'prompt changed' }) : null,
        pair.delta.output_changed ? el('span', { class: 'chip changed', text: 'output changed' }) : null,
        pair.delta.tools_changed ? el('span', { class: 'chip changed', text: 'tools changed' }) : null
      ])
    ]));
  }
  return container;
}

function compareSide(call, index) {
  if (!call) {
    return el('div', { class: 'compare-side missing', text: `call ${String(index).padStart(2, '0')} missing` });
  }
  return el('div', { class: 'compare-side' }, [
    el('span', { class: 'num', text: `call ${String(call.seq).padStart(2, '0')}` }),
    el('strong', { text: call.model || call.endpoint }),
    el('span', {
      text: `${fmt.ms(call.latency_ms)} · ${fmt.tokens(call.input_tokens)} in / ${fmt.tokens(call.output_tokens)} out · ${fmt.usd(call.cost_usd)}`
    }),
    call.error_type ? el('span', { class: 'run-err', text: call.error_type }) : null
  ]);
}

function deltaChip(label, value, suffix = '', money = false) {
  if (value === null) return null;
  const rendered = money
    ? `${value >= 0 ? '+' : '-'}${fmt.usd(Math.abs(value))}`
    : `${value >= 0 ? '+' : ''}${Math.round(value)}${suffix}`;
  return el('span', {
    class: `chip delta ${value > 0 ? 'worse' : value < 0 ? 'better' : ''}`,
    text: `${label} ${rendered}`
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
  const primary = 'npx orangebox-ai run --name "my agent" -- node agent.js';
  const envLines = state.platform === 'win32'
    ? `$env:ANTHROPIC_BASE_URL="${origin}/anthropic"\n$env:OPENAI_BASE_URL="${origin}/openai"`
    : `export ANTHROPIC_BASE_URL="${origin}/anthropic"\nexport OPENAI_BASE_URL="${origin}/openai"`;

  const copy = el('button', {
    class: 'btn',
    type: 'button',
    text: 'Copy',
    on: {
      click: async (e) => {
        try {
          await navigator.clipboard.writeText(primary);
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
    el('p', { class: 'note', text: 'Easiest start — replace node agent.js with your command:' }),
    el('div', { class: 'setup' }, [copy, el('pre', { text: primary })]),
    el('p', { class: 'note', text: 'Or point an already-running process at this recorder:' }),
    el('div', { class: 'setup' }, [el('pre', { text: envLines })]),
    el('p', { class: 'note', text: 'Works with the Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses APIs, including compatible custom upstreams.' })
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
    state.call && !state.readOnly
      ? el('button', {
          class: 'btn replay',
          type: 'button',
          text: 'Replay & edit',
          on: { click: () => replayCall(state.call) }
        })
      : null,
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

async function replayCall(call) {
  if (call.truncated) return void await showNotice('Replay unavailable', 'This call was truncated and cannot be replayed safely.');
  let request;
  try {
    request = JSON.parse(call.request_json);
    delete request._orangebox;
  } catch {
    return void await showNotice('Replay unavailable', 'The recorded request is not valid JSON.');
  }
  const answer = await openModal({
    title: 'Replay & edit',
    message: 'Edit the request. The replay is recorded as a new run and compared with this one.',
    fields: [{ name: 'request', label: 'Request JSON', type: 'textarea', value: JSON.stringify(request, null, 2), required: true }],
    confirmText: 'Replay'
  });
  if (!answer) return;
  try {
    request = JSON.parse(answer.request);
  } catch {
    return void await showNotice('Invalid JSON', 'The request must be valid JSON before it can be replayed.');
  }
  try {
    const result = await api.send('POST', `/api/calls/${encodeURIComponent(call.id)}/replay`, { request });
    await loadRuns();
    await navigate(result.run_id);
    state.comparison = await api.get(
      `/api/compare?left=${encodeURIComponent(call.run_id)}&right=${encodeURIComponent(result.run_id)}`
    );
    renderTimeline();
  } catch (error) {
    // A missing key is a setup problem, not a failure of the replay itself,
    // and the server has already said exactly which variable to set.
    const title = error.status === 400 && error.body?.error === 'missing replay credential'
      ? 'Replay needs a key'
      : 'Replay failed';
    await showNotice(title, error.message);
  }
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
  if (request.instructions !== undefined && request.instructions !== null) {
    out.push(messageCard('system', normalizeContent(request.instructions), { collapsed: true }));
  }
  for (const message of request.messages ?? []) {
    out.push(messageCard(message.role ?? 'user', normalizeContent(message.content), { message }));
  }
  if (typeof request.input === 'string') {
    out.push(messageCard('user', normalizeContent(request.input)));
  } else {
    for (const item of request.input ?? []) {
      if (item?.type === 'message' || item?.role) {
        out.push(messageCard(item.role ?? 'user', normalizeContent(item.content), { message: item }));
      } else if (item?.type === 'function_call_output') {
        out.push(messageCard('tool', [{
          type: 'tool_result',
          tool_use_id: item.call_id,
          is_error: item.status === 'failed',
          content: item.output
        }]));
      }
    }
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
    for (const item of response.output ?? []) {
      if (item?.type === 'message') {
        out.push(messageCard(item.role ?? 'assistant', normalizeContent(item.content), { label: 'response' }));
      } else if (item?.type === 'function_call') {
        out.push(messageCard('assistant', [{
          type: 'tool_use',
          name: item.name,
          id: item.call_id ?? item.id,
          input: item.arguments
        }], { label: 'response' }));
      }
    }
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
      typeof part === 'string'
        ? { type: 'text', text: part }
        : ['input_text', 'output_text'].includes(part?.type)
          ? { ...part, type: 'text' }
          : (part ?? { type: 'unknown' })
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
  source = new EventSource(`/api/live${authToken ? `?token=${encodeURIComponent(authToken)}` : ''}`);

  source.addEventListener('open', () => {
    backoff = 1000;
    setOnline(true);
  });

  const refresh = () => {
    loadRuns().catch(() => {});
    if (state.runId) loadRun(state.runId).catch(() => {});
  };

  source.addEventListener('run.created', refresh);
  source.addEventListener('run.updated', refresh);
  source.addEventListener('call.started', (event) => {
    const call = eventData(event);
    loadRuns().catch(() => {});
    if (!call) return;
    const seq = Math.max(0, ...state.calls.map((existing) => Number(existing.seq) || 0)) + 1;
    const placeholder = {
      id: call.call_id,
      run_id: call.run_id,
      seq,
      provider: call.provider,
      endpoint: call.endpoint,
      model: call.model,
      status: null,
      error_type: null,
      streamed: call.streamed,
      started_at: call.started_at,
      first_token_at: null,
      ended_at: null,
      latency_ms: null,
      ttft_ms: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      stop_reason: null,
      cost_usd: null,
      truncated: 0
    };
    state.inFlight.set(call.call_id, placeholder);
    if (call.run_id !== state.runId) return;
    if (!state.calls.some((existing) => existing.id === call.call_id)) state.calls.push(placeholder);
    renderTimeline();
    if (state.follow) scrollToLive();
  });
  source.addEventListener('call.first_token', (event) => {
    const update = eventData(event);
    if (!update || update.run_id !== state.runId) return;
    const call = state.calls.find((candidate) => candidate.id === update.call_id);
    if (!call) return;
    call.first_token_at = call.started_at + update.ttft_ms;
    call.ttft_ms = update.ttft_ms;
    const pending = state.inFlight.get(update.call_id);
    if (pending) {
      pending.first_token_at = call.first_token_at;
      pending.ttft_ms = update.ttft_ms;
    }
    renderTimeline();
  });
  source.addEventListener('call.completed', (event) => {
    const update = eventData(event);
    if (update?.call_id) state.inFlight.delete(update.call_id);
    notifyCallCompleted(update);
    refresh();
  });

  source.addEventListener('error', () => {
    setOnline(false);
    source.close();
    setTimeout(connectLive, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
}

function eventData(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function setOnline(online) {
  state.online = online;
  renderPill();
  syncMobileNav();
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

  if (e.key === 'Escape') {
    // Escape backs out of whatever is on top: the spend view, then the detail
    // pane. Two different exits on one key, in the order they were opened.
    if (state.view !== 'runs') return void closeAnalytics();
    return void closeDetail();
  }

  if (e.key === '$') {
    e.preventDefault();
    return void (state.view === 'spend' ? closeAnalytics() : openSpend());
  }

  if (e.key === 't') {
    e.preventDefault();
    return void (state.view === 'tools' ? closeAnalytics() : openTools());
  }

  if (e.key === '?') {
    e.preventDefault();
    return void openShortcutHelp();
  }

  if (e.key === '/') {
    e.preventDefault();
    return void (state.view === 'find' ? closeAnalytics() : openFind());
  }

  if (e.key === 'e') {
    e.preventDefault();
    return void (state.view === 'errors' ? closeAnalytics() : openErrors());
  }

  // The rest of these steer the timeline, which is not what is on screen.
  if (state.view !== 'runs') return;

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
  } else if (e.key === '\\') {
    e.preventDefault();
    setRunsCollapsed(!$('shell').classList.contains('runs-collapsed'));
  }
});

// ================================================== collapsible runs pane

/** §11.2 — 280px, collapsible. The choice sticks for the session. */
function setRunsCollapsed(collapsed) {
  if (window.innerWidth <= 900) {
    $('shell').classList.toggle('mobile-runs-open', !collapsed);
    $('runs-collapse').setAttribute('aria-expanded', String(!collapsed));
    syncMobileNav();
    return;
  }
  $('shell').classList.toggle('runs-collapsed', collapsed);
  $('runs-collapse').setAttribute('aria-expanded', String(!collapsed));
  try {
    localStorage.setItem('orangebox.runsCollapsed', collapsed ? '1' : '0');
  } catch {
    /* private browsing — the toggle still works, it just won't be remembered */
  }
}

$('runs-collapse').addEventListener('click', () => setRunsCollapsed(true));
$('runs-expand').addEventListener('click', () => setRunsCollapsed(false));
$('mobile-scrim').addEventListener('click', () => setRunsCollapsed(true));
$('mobile-runs').addEventListener('click', () => setRunsCollapsed(false));
$('mobile-timeline').addEventListener('click', () => closeDetail());
$('mobile-detail').addEventListener('click', () => {
  if (state.callId) void selectCall(state.callId);
});
$('runs-more').addEventListener('click', () => loadRuns({ append: true }).catch(() => {}));

function syncMobileNav() {
  const runsOpen = $('shell').classList.contains('mobile-runs-open');
  const detailOpen = $('shell').classList.contains('detail-open');
  $('mobile-runs').setAttribute('aria-current', runsOpen ? 'page' : 'false');
  $('mobile-timeline').setAttribute('aria-current', !runsOpen && !detailOpen ? 'page' : 'false');
  $('mobile-detail').setAttribute('aria-current', detailOpen ? 'page' : 'false');
  $('mobile-detail').disabled = !state.callId;
  $('mobile-live').classList.toggle('offline', !state.online);
  $('mobile-live').lastElementChild.textContent = state.online ? 'Live' : 'Offline';
}

const FILTER_INPUTS = [
  'run-search', 'run-model', 'run-provider', 'run-tool',
  'run-latency', 'run-cost', 'run-from', 'run-to'
];

/**
 * Land on the calls behind a spend row.
 *
 * Existing filters are cleared first: a drill-down that silently intersects
 * with whatever was already typed in the box would show a subset of the row
 * you clicked and still look like the answer.
 */
function applySpendDrilldown(filters) {
  for (const id of FILTER_INPUTS) $(id).value = '';
  $('run-errors').value = '';

  for (const [key, value] of Object.entries(filters)) {
    const input = $(`run-${key}`);
    if (input) input.value = value;
  }

  state.view = 'runs';
  state.filters = readRunFilters();
  history.pushState({}, '', '/');
  renderTimeline();
  syncMobileNav();
  loadRuns().catch(() => {});
}

function readRunFilters() {
  return {
    search: $('run-search').value.trim(),
    model: $('run-model').value.trim(),
    provider: $('run-provider').value.trim(),
    tool: $('run-tool').value.trim(),
    error: $('run-errors').value,
    min_latency: $('run-latency').value,
    min_cost: $('run-cost').value,
    from: dateBoundary($('run-from').value, false),
    to: dateBoundary($('run-to').value, true)
  };
}

let filterTimer = null;
function scheduleRunFilter() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    state.filters = readRunFilters();
    loadRuns().catch(() => {});
  }, 180);
}
function dateBoundary(value, endOfDay) {
  if (!value) return '';
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`);
  return String(date.getTime());
}

$('errors-open').addEventListener('click', () => {
  if (state.view === 'errors') closeAnalytics();
  else void openErrors();
});

$('find-open').addEventListener('click', () => {
  if (state.view === 'find') closeAnalytics();
  else void openFind();
});

$('tools-open').addEventListener('click', () => {
  if (state.view === 'tools') closeAnalytics();
  else void openTools();
});

$('spend-open').addEventListener('click', () => {
  if (state.view === 'spend') closeAnalytics();
  else void openSpend();
});

for (const id of FILTER_INPUTS.filter((id) => !id.endsWith('-from') && !id.endsWith('-to'))) {
  $(id).addEventListener('input', scheduleRunFilter);
}
for (const id of ['run-errors', 'run-from', 'run-to']) $(id).addEventListener('change', scheduleRunFilter);

try {
  if (localStorage.getItem('orangebox.runsCollapsed') === '1') setRunsCollapsed(true);
} catch {
  /* ignored */
}

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

// ============================================================ installable app

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  $('pwa-install').hidden = false;
});

$('pwa-install').addEventListener('click', async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('pwa-install').hidden = true;
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('pwa-install').hidden = true;
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}

// =================================================================== boot

async function boot() {
  try {
    const health = await api.get('/api/health');
    csrfToken = health.csrf_token;
    state.platform = health.platform;
    state.readOnly = health.mobile_session?.scope === 'read';
    state.mobileAccess = health.mobile_access === true;
    $('mobile-manage').hidden = health.mobile_manage !== true || state.readOnly;
    renderNotificationControl();
    // Read the route before anything else: loadRuns() lands on the newest run
    // when no run is named, and that replaceState overwrites /spend before we
    // would otherwise get around to looking at it.
    const bootSpend = pathIsSpend();
    const bootTools = pathIsTools();
    const bootFind = pathIsFind();
    const bootErrors = pathIsErrors();
    state.runId = pathRunId();
    renderPill();
    await loadRuns();
    if (state.runId) await loadRun(state.runId);
    if (bootSpend) await openSpend({ replace: true });
    if (bootTools) await openTools({ replace: true });
    if (bootFind) await openFind({ replace: true });
    if (bootErrors) await openErrors({ replace: true });
    connectLive();
  } catch (error) {
    // The user-facing message stays friendly, but swallowing the reason
    // entirely makes a boot failure impossible to diagnose from a bug report.
    console.error('orangebox: startup failed', error);
    if (await offerMobilePairing()) {
      syncMobileNav();
      return;
    }
    setOnline(false);
    $('timeline').replaceChildren(
      el('div', { class: 'empty' }, [
        el('h2', { text: 'Recorder unavailable' }),
        el('p', { text: 'The app shell is installed, but it cannot reach the orangebox recorder. Start orangebox on this computer and reload.' }),
        el('button', { class: 'btn primary', type: 'button', text: 'Reload', on: { click: () => location.reload() } })
      ])
    );
  }
  syncMobileNav();
}

async function offerMobilePairing() {
  let status;
  try {
    const response = await fetch('/api/mobile/status');
    if (!response.ok) return false;
    status = await response.json();
  } catch {
    return false;
  }
  if (!status.enabled) return false;

  setOnline(false);
  const root = $('timeline');
  const error = el('p', { class: 'pair-error', role: 'alert' });
  const form = el('form', { class: 'pair-form' }, [
    el('label', { class: 'modal-field' }, [
      el('span', { text: 'Pairing code' }),
      el('input', { name: 'code', type: 'text', required: true, autocomplete: 'one-time-code', autocapitalize: 'characters' })
    ]),
    el('button', { class: 'btn primary', type: 'submit', text: 'Pair this device' })
  ]);
  root.replaceChildren(el('div', { class: 'empty pair-card' }, [
    el('span', { class: 'pair-mark', text: '▮' }),
    el('h2', { text: 'Pair with this orangebox' }),
    el('p', { text: 'Enter the code shown in the orangebox terminal. Mobile access is read-only and expires when revoked, after 30 days, or when orangebox restarts.' }),
    form,
    error,
    el('p', { class: 'note', text: 'Only pair on a network you trust. Recorded prompts may contain secrets.' })
  ]));

  const submit = async (code) => {
    error.textContent = '';
    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Pairing…';
    try {
      const response = await fetch('/api/mobile/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, name: navigator.platform || 'Mobile device' })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Pairing failed');
      history.replaceState({}, '', `${location.pathname}${location.search}`);
      location.reload();
    } catch (pairError) {
      error.textContent = pairError.message;
      button.disabled = false;
      button.textContent = 'Pair this device';
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit(new FormData(form).get('code'));
  });

  const fragmentCode = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (fragmentCode) {
    form.elements.code.value = fragmentCode;
    void submit(fragmentCode);
  } else {
    form.elements.code.focus();
  }
  return true;
}

await boot();
