import crypto from 'node:crypto';

import { contextGrowth } from './context.mjs';
import { findLoops } from './loops.mjs';

export function compareRuns(store, leftId, rightId) {
  const left = store.getRun(leftId);
  const right = store.getRun(rightId);
  if (!left || !right) return null;
  const leftCalls = store.callSummaries(leftId);
  const rightCalls = store.callSummaries(rightId);
  const leftFull = store.fullCalls(leftId);
  const rightFull = store.fullCalls(rightId);
  const leftTools = toolsBySequence(store.toolEvents(leftId), leftFull);
  const rightTools = toolsBySequence(store.toolEvents(rightId), rightFull);
  const length = Math.max(leftCalls.length, rightCalls.length);
  return {
    left,
    right,
    pairs: Array.from({ length }, (_, index) => {
      const a = leftCalls[index] ?? null;
      const b = rightCalls[index] ?? null;
      return {
        index: index + 1,
        left: a,
        right: b,
        delta: {
          latency_ms: difference(b?.latency_ms, a?.latency_ms),
          input_tokens: difference(b?.input_tokens, a?.input_tokens),
          output_tokens: difference(b?.output_tokens, a?.output_tokens),
          cost_usd: difference(b?.cost_usd, a?.cost_usd),
          model_changed: Boolean(a && b && a.model !== b.model),
          error_changed: Boolean(a && b && a.error_type !== b.error_type),
          prompt_changed: changedJson(leftFull[index]?.request_json, rightFull[index]?.request_json),
          output_changed: changedJson(leftFull[index]?.response_json, rightFull[index]?.response_json),
          tools_changed: changedJson(leftTools.get(index + 1) ?? [], rightTools.get(index + 1) ?? [])
        }
      };
    })
  };
}

export function sanitizeExport(payload, { full = false } = {}) {
  const copy = structuredClone(payload);
  const ids = new Map();
  let nextId = 1;
  const clean = (value, key = '') => {
    if (typeof value === 'string') {
      let text = value
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
        .replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b/gi, '[redacted-secret]');
      if (full && /(^|_)(id|run_id|call_id|tool_use_id)$/.test(key) && text) {
        if (!ids.has(text)) ids.set(text, `id-${nextId++}`);
        text = ids.get(text);
      }
      return text;
    }
    if (Array.isArray(value)) return value.map((item) => clean(item, key));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [childKey, child] of Object.entries(value)) {
      // "token" here means an auth token. It also matches input_tokens,
      // output_tokens, cache_read_tokens and max_tokens, which are counts —
      // and redacting those left every shared run with no usage data and no
      // record of what the request asked for. A credential is never a number,
      // so a finite number under one of these keys is kept and everything
      // else, including a numeric-looking string, still goes.
      if (/auth|api.?key|token|secret|cookie/i.test(childKey) && !Number.isFinite(child)) {
        out[childKey] = '[redacted-secret]';
      }
      else if (/^(system|instructions)$/i.test(childKey)) out[childKey] = '[redacted-system-prompt]';
      else out[childKey] = clean(child, childKey);
    }
    if (out.role === 'system' && 'content' in out) out.content = '[redacted-system-prompt]';
    return out;
  };

  for (const call of copy.calls ?? []) {
    call.request_json = sanitizeJsonString(call.request_json, clean);
    call.response_json = sanitizeJsonString(call.response_json, clean);
  }
  for (const tool of copy.tools ?? []) {
    tool.content_json = tool.content_json == null ? null : '"[redacted-tool-content]"';
  }
  return clean(copy);
}

export function buildHtmlReport(payload) {
  const run = payload.run;
  const calls = payload.calls ?? [];
  const rows = calls.map((call) => `
    <article>
      <h2>Call ${escapeHtml(String(call.seq).padStart(2, '0'))} &middot; ${escapeHtml(call.model ?? call.endpoint)}</h2>
      <p>${escapeHtml(call.provider)} &middot; ${escapeHtml(formatMs(call.latency_ms))} &middot; ${escapeHtml(formatTokens(call))} &middot; ${escapeHtml(formatCost(call.cost_usd))}</p>
      <details><summary>Request</summary><pre>${escapeHtml(prettyJson(call.request_json))}</pre></details>
      <details><summary>Response</summary><pre>${escapeHtml(prettyJson(call.response_json))}</pre></details>
    </article>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(run.name ?? run.id)} &middot; orangebox report</title>
<style>${REPORT_CSS}</style></head>
<body>
<h1>${escapeHtml(run.name ?? run.id)}</h1>
${summarySection(run, calls)}
${rows}
<footer>Sanitized orangebox report &middot; generated ${escapeHtml(new Date(payload.exported_at).toISOString())}</footer>
</body></html>`;
}

const REPORT_CSS = 'body{max-width:980px;margin:40px auto;padding:0 20px;background:#111318;color:#e7e9ed;font:14px system-ui}'
  + 'h1{color:#ff6b35}article{border:1px solid #30343b;border-radius:8px;padding:16px;margin:18px 0;background:#191c22}'
  + 'h2{font-size:16px}p,summary{color:#9da3ad}'
  + 'pre{white-space:pre-wrap;word-break:break-word;background:#0d0f12;padding:14px;border-radius:6px;max-height:520px;overflow:auto}'
  + 'footer{margin-top:32px;color:#777}'
  + 'dl.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px 20px;margin:0;'
  + 'border:1px solid #30343b;border-radius:8px;padding:16px;background:#191c22}'
  + 'dl.summary dt{color:#9da3ad;font-size:12px;margin:0 0 3px}dl.summary dd{margin:0;font-size:18px}'
  + 'dl.summary dd small{display:block;font-size:11px;color:#777;margin-top:3px}'
  + '.flag{margin:14px 0 0;padding:10px 12px;border-radius:6px;border:1px solid #5a4318;background:rgba(232,163,61,.1);color:#e8a33d}';

/**
 * The numbers somebody opens the report to find, above the calls.
 *
 * A bug report is read by someone who was not there. Making them add up
 * fifteen per-call costs to answer "what did this cost" is how a report gets
 * skimmed and then ignored.
 */
function summarySection(run, calls) {
  const growth = contextGrowth(calls);
  const loops = findLoops(calls);
  const errors = calls.filter((call) => call.error_type).length;

  const items = [
    ['Calls', String(calls.length), errors > 0 ? `${errors} failed` : null],
    ['Estimated cost', `${formatCost(run.cost_usd)}${run.unknown_cost_count ? '+' : ''}`,
      run.unknown_cost_count ? `${run.unknown_cost_count} could not be priced` : null],
    ['Input tokens', formatTokenCount(growth.total_input_tokens),
      growth.cached_share ? `${Math.round(growth.cached_share * 100)}% served from cache` : null],
    ['Largest prompt', formatTokenCount(growth.peak_tokens),
      growth.growth ? `${growth.growth.toFixed(1)}x the first` : null]
  ];

  const flags = [];
  if (loops.loops.length > 0) {
    const worst = loops.loops[0];
    flags.push(`${worst.count} calls asked the same thing, costing ${formatCost(loops.wasted_usd)} in repeats.`);
  }
  if (growth.growth >= 5 && (growth.cached_share ?? 0) < 0.25 && growth.calls >= 4) {
    flags.push(`The prompt grew ${growth.growth.toFixed(1)}x and almost none of it was cached.`);
  }

  return `<dl class="summary">${items.map(([label, value, note]) => `
  <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}${note ? `<small>${escapeHtml(note)}</small>` : ''}</dd></div>`).join('')}
</dl>${flags.map((text) => `
<p class="flag">${escapeHtml(text)}</p>`).join('')}`;
}

function formatTokenCount(value) {
  if (value === null || value === undefined) return '—';
  if (value < 10000) return String(value);
  if (value < 1000000) return `${(value / 1000).toFixed(value < 100000 ? 1 : 0)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}

export function buildOtelExport(payload) {
  const run = payload.run;
  const toolsByCall = new Map();
  for (const tool of payload.tools ?? []) {
    if (!toolsByCall.has(tool.call_id)) toolsByCall.set(tool.call_id, []);
    toolsByCall.get(tool.call_id).push(tool);
  }
  const traceId = digest(run.id, 32);
  const rootSpanId = digest(`${run.id}:run`, 16);
  const calls = payload.calls ?? [];

  const spans = calls.map((call) => ({
    traceId,
    spanId: digest(call.id, 16),
    parentSpanId: rootSpanId,
    name: `${operationName(call)} ${call.model ?? call.endpoint}`,
    kind: 3,
    startTimeUnixNano: toNano(call.started_at),
    endTimeUnixNano: toNano(call.ended_at ?? call.started_at),
    attributes: compactAttributes({
      'gen_ai.operation.name': operationName(call),
      'gen_ai.provider.name': call.provider,
      'gen_ai.request.model': call.model,
      'gen_ai.response.model': call.model,
      'gen_ai.request.stream': Boolean(call.streamed),
      'gen_ai.response.time_to_first_chunk': call.ttft_ms == null ? null : call.ttft_ms / 1000,
      'gen_ai.usage.input_tokens': call.input_tokens,
      'gen_ai.usage.output_tokens': call.output_tokens,
      'gen_ai.usage.cache_read.input_tokens': call.cache_read_tokens,
      'gen_ai.usage.cache_creation.input_tokens': call.cache_write_tokens,
      'openai.api.type': call.provider === 'openai'
        ? (call.endpoint?.includes('/responses') ? 'responses' : 'chat_completions')
        : null,
      'error.type': call.error_type
    }),
    events: (toolsByCall.get(call.id) ?? []).map((tool) => ({
      timeUnixNano: toNano(call.ended_at ?? call.started_at),
      name: `gen_ai.${tool.kind}`,
      attributes: compactAttributes({
        'gen_ai.tool.name': tool.tool_name,
        'gen_ai.tool.call.id': tool.tool_use_id,
        'error.type': tool.is_error ? 'tool_error' : null
      })
    })),
    status: call.error_type ? { code: 2, message: call.error_type } : { code: 1 }
  }));

  return {
    resourceSpans: [{
      resource: { attributes: compactAttributes({ 'service.name': 'orangebox', 'service.version': payload.orangebox_version }) },
      scopeSpans: [{
        scope: { name: 'orangebox.export', version: payload.orangebox_version },
        spans: [runSpan(run, calls, traceId, rootSpanId), ...spans]
      }]
    }]
  };
}

/**
 * The run itself, as the parent of every call in it.
 *
 * Without this the export is a flat handful of siblings that a trace viewer
 * draws as unrelated root spans — the agent loop, the thing you exported the
 * run to look at, is the one shape the trace does not have.
 *
 * It also carries what only the whole run knows: what it cost, how far the
 * prompt grew, and whether it went in circles. Those are run-level facts, and
 * hanging them off the first call would be a lie about where they came from.
 */
function runSpan(run, calls, traceId, spanId) {
  const growth = contextGrowth(calls);
  const loops = findLoops(calls);
  const ends = calls.map((call) => call.ended_at ?? call.started_at).filter(Boolean);

  return {
    traceId,
    spanId,
    name: run.name ? `agent run ${run.name}` : 'agent run',
    kind: 1, // SERVER: the run is the unit of work orangebox itself observed.
    startTimeUnixNano: toNano(run.started_at ?? calls[0]?.started_at),
    endTimeUnixNano: toNano(run.ended_at ?? (ends.length ? Math.max(...ends) : run.started_at)),
    attributes: compactAttributes({
      'orangebox.run.id': run.id,
      'orangebox.run.name': run.name,
      'orangebox.run.source': run.source,
      'orangebox.run.calls': run.call_count ?? calls.length,
      'orangebox.run.errors': run.error_count,
      'orangebox.run.cost_usd': run.cost_usd,
      // Named "estimated" because it is: a local price table applied to
      // reported usage, never a figure from the provider's billing.
      'orangebox.run.cost_estimated': true,
      'orangebox.run.unknown_cost_calls': run.unknown_cost_count,
      'orangebox.context.first_tokens': growth.first_tokens,
      'orangebox.context.peak_tokens': growth.peak_tokens,
      'orangebox.context.growth': growth.growth,
      'orangebox.context.cached_share': growth.cached_share,
      'orangebox.loops.repeated_prompts': loops.loops.length,
      'orangebox.loops.looping_calls': loops.looping_calls,
      'orangebox.loops.wasted_usd': loops.wasted_usd,
      'gen_ai.usage.input_tokens': growth.total_input_tokens || null
    }),
    status: run.error_count > 0 ? { code: 2, message: `${run.error_count} failed call(s)` } : { code: 1 }
  };
}

function sanitizeJsonString(value, cleaner) {
  if (value == null) return value;
  try {
    return JSON.stringify(cleaner(JSON.parse(value)));
  } catch {
    return cleaner(String(value));
  }
}

function difference(a, b) {
  return typeof a === 'number' && typeof b === 'number' ? a - b : null;
}

function changedJson(left, right) {
  if (left === undefined && right === undefined) return false;
  if (left === undefined || right === undefined) return true;
  return stableJson(left) !== stableJson(right);
}

function stableJson(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return value; }
  }
  return JSON.stringify(canonicalize(parsed));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => key !== '_orangebox')
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function toolsBySequence(tools, calls) {
  const sequenceByCall = new Map(calls.map((call) => [call.id, call.seq]));
  const grouped = new Map();
  for (const tool of tools) {
    const seq = sequenceByCall.get(tool.call_id);
    if (!seq) continue;
    if (!grouped.has(seq)) grouped.set(seq, []);
    grouped.get(seq).push({ kind: tool.kind, tool_name: tool.tool_name, is_error: tool.is_error });
  }
  return grouped;
}

function compactAttributes(record) {
  return Object.entries(record)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => ({ key, value: attributeValue(value) }));
}

function attributeValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  return { stringValue: String(value) };
}

function operationName(call) {
  return 'chat';
}

function digest(value, length) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function toNano(ms) {
  return String(BigInt(Math.trunc(ms ?? 0)) * 1_000_000n);
}

function prettyJson(value) {
  if (value == null) return '—';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return String(value);
  }
}

function formatMs(value) {
  return value == null ? '—' : `${value} ms`;
}

function formatTokens(call) {
  return `${call.input_tokens ?? '—'} in / ${call.output_tokens ?? '—'} out`;
}

function formatCost(value) {
  return value == null ? '—' : `$${Number(value).toFixed(4)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
