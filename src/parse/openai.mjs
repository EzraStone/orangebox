// §7.3 — OpenAI Chat Completions and Responses API. Same interface as the
// Anthropic module; unrecognized shapes degrade to nulls rather than throwing.
import { parseSseFrames, parseFrameJson } from './sse.mjs';

export const provider = 'openai';

export function parseRequest(json) {
  if (!isObject(json)) return { model: null, stream: false };
  return {
    model: str(json.model),
    stream: json.stream === true
  };
}

export function parseResponse(json) {
  if (!isObject(json)) return emptyResult();
  const usage = isObject(json.usage) ? json.usage : {};
  if (Array.isArray(json.output) || json.object === 'response') {
    return {
      model: str(json.model),
      stop_reason:
        str(json.incomplete_details?.reason) ??
        (json.status === 'completed' ? 'completed' : str(json.status)),
      input_tokens: int(usage.input_tokens),
      output_tokens: int(usage.output_tokens),
      cache_read_tokens: int(usage.input_tokens_details?.cached_tokens),
      cache_write_tokens: null
    };
  }
  const choice = Array.isArray(json.choices) && isObject(json.choices[0]) ? json.choices[0] : {};
  return {
    model: str(json.model),
    stop_reason: str(choice.finish_reason),
    input_tokens: int(usage.prompt_tokens),
    output_tokens: int(usage.completion_tokens),
    // Chat Completions reports no cache-write counts, and §7.3 does not map
    // prompt_tokens_details.cached_tokens (it is a subset of prompt_tokens,
    // so counting it separately would double-bill in §08).
    cache_read_tokens: null,
    cache_write_tokens: null
  };
}

/**
 * §7.3 — fold a captured SSE transcript into a Chat Completions object.
 * Usage only exists when the client asked for `stream_options.include_usage`;
 * otherwise the token fields stay null and the UI says why.
 */
export function reassembleStream(sseText) {
  const frames = parseSseFrames(sseText);
  const isResponses = frames.some((frame) => {
    const event = parseFrameJson(frame.data);
    return typeof event?.type === 'string' && event.type.startsWith('response.');
  });
  return isResponses ? reassembleResponsesStream(frames) : reassembleChatStream(frames);
}

function reassembleChatStream(frames) {
  const message = { role: 'assistant', content: null, tool_calls: [] };
  const toolCalls = new Map(); // index -> { id, type, function: { name, arguments } }

  let id = null;
  let model = null;
  let created = null;
  let finishReason = null;
  let usage = null;
  let text = '';
  let sawContent = false;
  let sawAnything = false;
  let error = null;

  for (const frame of frames) {
    if (frame.data === '[DONE]') break;

    const chunk = parseFrameJson(frame.data);
    if (!isObject(chunk)) continue;
    sawAnything = true;

    if (chunk.error) {
      error = chunk.error;
      continue;
    }

    id ??= str(chunk.id);
    model ??= str(chunk.model);
    created ??= int(chunk.created);
    if (isObject(chunk.usage)) usage = chunk.usage;

    const choice = Array.isArray(chunk.choices) && isObject(chunk.choices[0]) ? chunk.choices[0] : null;
    if (!choice) continue;

    if (choice.finish_reason) finishReason = str(choice.finish_reason);

    const delta = isObject(choice.delta) ? choice.delta : {};
    if (typeof delta.content === 'string') {
      text += delta.content;
      sawContent = true;
    }
    if (typeof delta.refusal === 'string') {
      message.refusal = (message.refusal ?? '') + delta.refusal;
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        if (!isObject(part)) continue;
        const index = int(part.index) ?? toolCalls.size;
        const entry = toolCalls.get(index) ?? {
          id: null,
          type: 'function',
          function: { name: null, arguments: '' }
        };
        if (str(part.id)) entry.id = str(part.id);
        if (str(part.type)) entry.type = str(part.type);
        if (isObject(part.function)) {
          if (str(part.function.name)) entry.function.name = str(part.function.name);
          if (typeof part.function.arguments === 'string') {
            entry.function.arguments += part.function.arguments;
          }
        }
        toolCalls.set(index, entry);
      }
    }
  }

  if (!sawAnything) return { response: null, error };

  message.content = sawContent ? text : null;
  message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  if (message.tool_calls.length === 0) delete message.tool_calls;

  return {
    response: {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
      ...(usage ? { usage } : {})
    },
    error
  };
}

function reassembleResponsesStream(frames) {
  let response = null;
  let error = null;
  const output = new Map();

  for (const frame of frames) {
    const event = parseFrameJson(frame.data);
    if (!isObject(event)) continue;

    if (event.type === 'error' || event.type === 'response.failed') {
      error = event.error ?? event.response?.error ?? event;
    }
    if (isObject(event.response)) {
      response = { ...(response ?? {}), ...event.response };
      if (Array.isArray(event.response.output)) {
        event.response.output.forEach((item, index) => output.set(index, structuredClone(item)));
      }
    }

    const index = int(event.output_index);
    if (index !== null && isObject(event.item)) {
      if (event.type === 'response.output_item.done') {
        output.set(index, structuredClone(event.item));
      } else if (!output.has(index)) {
        output.set(index, structuredClone(event.item));
      }
    }

    if (event.type === 'response.output_text.delta' && index !== null) {
      const item = ensureOutputMessage(output, index, event.item_id);
      const contentIndex = int(event.content_index) ?? 0;
      item.content[contentIndex] ??= { type: 'output_text', text: '', annotations: [] };
      item.content[contentIndex].text += typeof event.delta === 'string' ? event.delta : '';
    }

    if (event.type === 'response.function_call_arguments.delta' && index !== null) {
      const item = output.get(index) ?? {
        type: 'function_call',
        id: event.item_id ?? null,
        call_id: event.item_id ?? null,
        name: null,
        arguments: ''
      };
      item.arguments = (item.arguments ?? '') + (typeof event.delta === 'string' ? event.delta : '');
      output.set(index, item);
    }
  }

  if (!response && output.size === 0) return { response: null, error };
  return {
    response: {
      object: 'response',
      status: error ? 'failed' : 'incomplete',
      ...(response ?? {}),
      output: [...output.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item)
    },
    error
  };
}

/** §7.4 — tool_calls the model asked for. `arguments` is a JSON string; keep the raw on parse failure. */
export function extractToolUses(response) {
  if (isObject(response) && Array.isArray(response.output)) {
    return response.output
      .filter((item) => isObject(item) && item.type === 'function_call')
      .map((item) => ({
        tool_name: str(item.name),
        tool_use_id: str(item.call_id) ?? str(item.id),
        is_error: 0,
        content: parseArguments(item.arguments)
      }));
  }
  if (!isObject(response) || !Array.isArray(response.choices)) return [];
  const choice = response.choices[0];
  const message = isObject(choice) ? choice.message : null;
  if (!isObject(message) || !Array.isArray(message.tool_calls)) return [];

  return message.tool_calls
    .filter(isObject)
    .map((call) => {
      const fn = isObject(call.function) ? call.function : {};
      return {
        tool_name: str(fn.name),
        tool_use_id: str(call.id),
        is_error: 0,
        content: parseArguments(fn.arguments)
      };
    });
}

/** §7.4 — `role: 'tool'` messages carrying results back to the model. */
export function extractToolResults(request) {
  if (isObject(request) && Array.isArray(request.input)) {
    return request.input
      .filter((item) => isObject(item) && item.type === 'function_call_output')
      .map((item) => ({
        tool_name: null,
        tool_use_id: str(item.call_id),
        is_error: item.status === 'failed' ? 1 : 0,
        content: item.output ?? null
      }));
  }
  if (!isObject(request) || !Array.isArray(request.messages)) return [];
  return request.messages
    .filter((m) => isObject(m) && m.role === 'tool')
    .map((m) => ({
      tool_name: str(m.name),
      tool_use_id: str(m.tool_call_id),
      is_error: 0, // Chat Completions has no error flag on tool results
      content: m.content ?? null
    }));
}

// --------------------------------------------------------------- helpers

function parseArguments(raw) {
  if (typeof raw !== 'string') return raw ?? null;
  if (raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _orangebox_unparsed_arguments: raw };
  }
}

function ensureOutputMessage(output, index, id) {
  const existing = output.get(index);
  if (isObject(existing) && existing.type === 'message') {
    existing.content ??= [];
    return existing;
  }
  const item = {
    type: 'message',
    id: id ?? null,
    role: 'assistant',
    status: 'in_progress',
    content: []
  };
  output.set(index, item);
  return item;
}

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
