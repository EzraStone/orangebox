// §7.2 — Anthropic Messages API. Every function here is defensive: an
// unrecognized shape degrades to nulls, never a throw and never a lost record.
import { parseSseFrames, parseFrameJson } from './sse.mjs';

export const provider = 'anthropic';

/** §7.2 request: what we need for routing, detection, and display. */
export function parseRequest(json) {
  if (!isObject(json)) return { model: null, stream: false };
  return {
    model: str(json.model),
    stream: json.stream === true
  };
}

/** §7.2 response: model, stop reason, and the four token counts. */
export function parseResponse(json) {
  if (!isObject(json)) return emptyResult();
  const usage = isObject(json.usage) ? json.usage : {};
  return {
    model: str(json.model),
    stop_reason: str(json.stop_reason),
    input_tokens: int(usage.input_tokens),
    output_tokens: int(usage.output_tokens),
    cache_read_tokens: int(usage.cache_read_input_tokens),
    cache_write_tokens: int(usage.cache_creation_input_tokens)
  };
}

/**
 * §7.2.1 — fold a captured SSE transcript back into the message object the
 * client would have received without `stream: true`.
 * Returns { response, error } — `error` is set only when the stream carried an
 * explicit `error` event.
 */
export function reassembleStream(sseText) {
  const message = {
    id: null,
    type: 'message',
    role: 'assistant',
    model: null,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {}
  };

  const blocks = new Map(); // index -> { block, buffer }
  let error = null;
  let sawAnything = false;

  for (const frame of parseSseFrames(sseText)) {
    const type = frame.event ?? undefined;
    if (type === 'ping') continue;

    const payload = parseFrameJson(frame.data);
    if (!isObject(payload)) continue;
    sawAnything = true;

    switch (payload.type ?? type) {
      case 'message_start': {
        const m = isObject(payload.message) ? payload.message : {};
        message.id = str(m.id) ?? message.id;
        message.model = str(m.model) ?? message.model;
        message.role = str(m.role) ?? message.role;
        if (isObject(m.usage)) Object.assign(message.usage, m.usage);
        break;
      }

      case 'content_block_start': {
        const start = isObject(payload.content_block) ? payload.content_block : {};
        const index = int(payload.index) ?? blocks.size;
        const block =
          start.type === 'tool_use'
            ? { type: 'tool_use', id: str(start.id), name: str(start.name), input: {} }
            : { ...start, text: typeof start.text === 'string' ? start.text : '' };
        blocks.set(index, { block, buffer: '' });
        break;
      }

      case 'content_block_delta': {
        const index = int(payload.index) ?? 0;
        const entry = blocks.get(index);
        if (!entry) break;
        const delta = isObject(payload.delta) ? payload.delta : {};
        if (typeof delta.text === 'string') entry.block.text = (entry.block.text ?? '') + delta.text;
        else if (typeof delta.thinking === 'string')
          entry.block.thinking = (entry.block.thinking ?? '') + delta.thinking;
        else if (typeof delta.partial_json === 'string') entry.buffer += delta.partial_json;
        break;
      }

      case 'content_block_stop': {
        const entry = blocks.get(int(payload.index) ?? 0);
        if (!entry) break;
        if (entry.block.type === 'tool_use' && entry.buffer !== '') {
          try {
            entry.block.input = JSON.parse(entry.buffer);
          } catch {
            // Keep the fragment rather than dropping the call's arguments (§7.2.1.5).
            entry.block.input_raw = entry.buffer;
          }
        }
        break;
      }

      case 'message_delta': {
        const delta = isObject(payload.delta) ? payload.delta : {};
        if (delta.stop_reason !== undefined) message.stop_reason = str(delta.stop_reason);
        if (delta.stop_sequence !== undefined) message.stop_sequence = delta.stop_sequence ?? null;
        if (isObject(payload.usage)) Object.assign(message.usage, payload.usage);
        break;
      }

      case 'message_stop':
        break;

      case 'error':
        error = payload.error ?? payload;
        break;

      default:
        break; // unknown event types are not our business
    }
  }

  message.content = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, entry]) => entry.block);

  return { response: sawAnything ? message : null, error };
}

/** §7.4 — tool_use blocks emitted by the model. */
export function extractToolUses(response) {
  if (!isObject(response) || !Array.isArray(response.content)) return [];
  return response.content
    .filter((block) => isObject(block) && block.type === 'tool_use')
    .map((block) => ({
      tool_name: str(block.name),
      tool_use_id: str(block.id),
      is_error: 0,
      content: block.input ?? block.input_raw ?? null
    }));
}

/** §7.4 — tool_result blocks the client sent back, wherever they sit in the history. */
export function extractToolResults(request) {
  if (!isObject(request) || !Array.isArray(request.messages)) return [];
  const out = [];
  for (const message of request.messages) {
    if (!isObject(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isObject(block) || block.type !== 'tool_result') continue;
      out.push({
        tool_name: null, // resolved from the paired tool_use when the UI renders
        tool_use_id: str(block.tool_use_id),
        is_error: block.is_error === true ? 1 : 0,
        content: block.content ?? null
      });
    }
  }
  return out;
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
