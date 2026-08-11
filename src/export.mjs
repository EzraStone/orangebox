import crypto from 'node:crypto';

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
      if (/auth|api.?key|token|secret|cookie/i.test(childKey)) out[childKey] = '[redacted-secret]';
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
      <h2>Call ${escapeHtml(String(call.seq).padStart(2, '0'))} · ${escapeHtml(call.model ?? call.endpoint)}</h2>
      <p>${escapeHtml(call.provider)} · ${escapeHtml(formatMs(call.latency_ms))} · ${escapeHtml(formatTokens(call))} · ${escapeHtml(formatCost(call.cost_usd))}</p>
      <details><summary>Request</summary><pre>${escapeHtml(prettyJson(call.request_json))}</pre></details>
      <details><summary>Response</summary><pre>${escapeHtml(prettyJson(call.response_json))}</pre></details>
    </article>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(run.name ?? run.id)} · orangebox report</title>
<style>body{max-width:980px;margin:40px auto;padding:0 20px;background:#111318;color:#e7e9ed;font:14px system-ui}h1{color:#ff6b35}article{border:1px solid #30343b;border-radius:8px;padding:16px;margin:18px 0;background:#191c22}h2{font-size:16px}p,summary{color:#9da3ad}pre{white-space:pre-wrap;word-break:break-word;background:#0d0f12;padding:14px;border-radius:6px;max-height:520px;overflow:auto}footer{margin-top:32px;color:#777}</style></head>
<body><h1>${escapeHtml(run.name ?? run.id)}</h1><p>${calls.length} calls · ${escapeHtml(formatCost(run.cost_usd))}${run.unknown_cost_count ? '+' : ''} estimated</p>${rows}<footer>Sanitized orangebox report · generated ${escapeHtml(new Date(payload.exported_at).toISOString())}</footer></body></html>`;
}

export function buildOtelExport(payload) {
  const run = payload.run;
  const toolsByCall = new Map();
  for (const tool of payload.tools ?? []) {
    if (!toolsByCall.has(tool.call_id)) toolsByCall.set(tool.call_id, []);
    toolsByCall.get(tool.call_id).push(tool);
  }
  const traceId = digest(run.id, 32);
  const spans = (payload.calls ?? []).map((call) => ({
    traceId,
    spanId: digest(call.id, 16),
    name: `${operationName(call)} ${call.model ?? call.endpoint}`,
    kind: 3,
    startTimeUnixNano: toNano(call.started_at),
    endTimeUnixNano: toNano(call.ended_at ?? call.started_at),
    attributes: compactAttributes({
      'gen_ai.operation.name': operationName(call),
      'gen_ai.provider.name': call.provider,
      'gen_ai.request.model': call.model,
      'gen_ai.response.model': call.model,
      'gen_ai.usage.input_tokens': call.input_tokens,
      'gen_ai.usage.output_tokens': call.output_tokens,
      'server.address': call.endpoint,
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
      scopeSpans: [{ scope: { name: 'orangebox.export', version: payload.orangebox_version }, spans }]
    }]
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
  return call.endpoint?.includes('/responses') ? 'responses' : 'chat';
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
