// §19.3 — Ollama, and any other server speaking its native /api/chat shape.
//
// Two things make this the useful third provider rather than a fourth flavour
// of the same thing:
//
//   1. The stream is newline-delimited JSON, not server-sent events. Every line
//      is a complete response object. No `event:` lines, no `data:` prefix, no
//      blank-line framing — so it proves the parser interface actually isolates
//      the wire format instead of quietly assuming SSE everywhere.
//   2. `stream` defaults to TRUE when omitted, the opposite of both hosted
//      providers. Getting that backwards would silently mark real streams as
//      non-streamed and lose every TTFT measurement on this provider.
//
// Tool call arguments arrive as a parsed object here, not a JSON string.
export const provider = 'ollama';

export function parseRequest(json) {
  if (!isObject(json)) return { model: null, stream: false };
  return {
    model: str(json.model),
    // Ollama streams unless told not to. `stream: false` is the opt-out.
    stream: json.stream !== false
  };
}

export function parseResponse(json) {
  if (!isObject(json)) return emptyResult();
  return {
    model: str(json.model),
    // done_reason is 'stop' | 'length' | 'load' | 'unload'; older builds omit
    // it and only report done:true, which still means the turn finished.
    stop_reason: str(json.done_reason) ?? (json.done === true ? 'stop' : null),
    input_tokens: int(json.prompt_eval_count),
    output_tokens: int(json.eval_count),
    // Local inference has no prompt cache to bill for.
    cache_read_tokens: null,
    cache_write_tokens: null
  };
}

/**
 * Fold an NDJSON transcript into the single object a non-streamed call returns.
 * Ollama emits one complete JSON object per line; the last carries done:true
 * along with the token counts and timings.
 */
export function reassembleStream(text) {
  if (typeof text !== 'string' || text === '') return { response: null, error: null };

  let merged = null;
  let content = '';
  const toolCalls = [];
  let error = null;
  let sawAnything = false;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let chunk;
    try {
      chunk = JSON.parse(trimmed);
    } catch {
      continue; // a partial trailing line is normal on an aborted stream
    }
    if (!isObject(chunk)) continue;
    sawAnything = true;

    if (chunk.error) {
      error = typeof chunk.error === 'string' ? { message: chunk.error } : chunk.error;
      continue;
    }

    merged = { ...(merged ?? {}), ...chunk };

    const message = isObject(chunk.message) ? chunk.message : null;
    if (message) {
      if (typeof message.content === 'string') content += message.content;
      if (Array.isArray(message.tool_calls)) toolCalls.push(...message.tool_calls.filter(isObject));
    }
  }

  if (!sawAnything) return { response: null, error };

  const response = {
    ...(merged ?? {}),
    message: {
      role: 'assistant',
      ...(isObject(merged?.message) ? merged.message : {}),
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    }
  };

  return { response, error };
}

/** §7.4 — tool calls the model asked for. `arguments` is already an object here. */
export function extractToolUses(response) {
  if (!isObject(response)) return [];
  const message = isObject(response.message) ? response.message : null;
  if (!message || !Array.isArray(message.tool_calls)) return [];

  return message.tool_calls.filter(isObject).map((call, index) => {
    const fn = isObject(call.function) ? call.function : {};
    return {
      tool_name: str(fn.name),
      // Ollama assigns no id, so pair on name+position the way the client must.
      tool_use_id: str(call.id) ?? (str(fn.name) ? `${fn.name}#${index}` : null),
      is_error: 0,
      content: fn.arguments ?? null
    };
  });
}

/** §7.4 — `role: 'tool'` messages carrying results back into the conversation. */
export function extractToolResults(request) {
  if (!isObject(request) || !Array.isArray(request.messages)) return [];
  let index = 0;
  return request.messages
    .filter((m) => isObject(m) && m.role === 'tool')
    .map((m) => ({
      tool_name: str(m.tool_name) ?? str(m.name),
      tool_use_id:
        str(m.tool_call_id) ?? (str(m.tool_name) ?? str(m.name) ? `${m.tool_name ?? m.name}#${index++}` : null),
      is_error: 0,
      content: m.content ?? null
    }));
}

// --------------------------------------------------------------- helpers

function emptyResult() {
  return {
    model: null,
    stop_reason: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null
  };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function int(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}
