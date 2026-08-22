// §07 / §19.3 — Amazon Bedrock, Converse and ConverseStream.
//
// Two things make Bedrock different from the other three providers:
//
// 1. The model id lives in the URL, not the body:
//      POST /model/{modelId}/converse
//      POST /model/{modelId}/converse-stream
//    and it is URL-encoded, because Bedrock ids contain dots, colons and
//    slashes (us.anthropic.claude-sonnet-4-5-20250929-v1:0).
//
// 2. Streaming is AWS event-stream binary frames, not SSE. See eventstream.mjs.
//
// Auth note (§12.2): orangebox strips the Host header like any reverse proxy,
// which invalidates a SigV4 signature — SigV4 signs the host. Bedrock through
// orangebox therefore needs bearer-token auth (a Bedrock API key), which is
// forwarded and redacted exactly like every other provider's key. There is no
// way around this short of orangebox holding your AWS credentials and
// re-signing, which it will not do.
import { splitFrames, frameJson } from './eventstream.mjs';

export const provider = 'bedrock';

const MODEL_IN_PATH = /\/model\/([^/]+)\/(converse-stream|converse|invoke-with-response-stream|invoke)/;

/** Pull the model id and the streaming choice out of the request path. */
export function splitEndpoint(endpoint) {
  const match = typeof endpoint === 'string' ? endpoint.match(MODEL_IN_PATH) : null;
  if (!match) return { model: null, streaming: false };

  let model = match[1];
  try {
    model = decodeURIComponent(model);
  } catch {
    // A malformed escape is not worth losing the record over; keep it raw.
  }
  return { model, streaming: match[2].endsWith('-stream') };
}

/** §7.2 request. Everything interesting is in the URL, not the body. */
export function parseRequest(json, { endpoint } = {}) {
  const { model, streaming } = splitEndpoint(endpoint);
  return { model, stream: streaming };
}

/** §7.3 response: Converse returns usage under `usage`, with AWS's spelling. */
export function parseResponse(json, { endpoint } = {}) {
  if (!isObject(json)) return emptyResult();
  const usage = isObject(json.usage) ? json.usage : {};
  return {
    model: splitEndpoint(endpoint).model,
    stop_reason: str(json.stopReason),
    input_tokens: int(usage.inputTokens),
    output_tokens: int(usage.outputTokens),
    cache_read_tokens: int(usage.cacheReadInputTokens),
    cache_write_tokens: int(usage.cacheWriteInputTokens)
  };
}

/**
 * §7.2.1 — fold a captured ConverseStream transcript back into the object a
 * non-streaming `converse` call would have returned.
 *
 * The event sequence is messageStart, then per content block
 * contentBlockStart / contentBlockDelta* / contentBlockStop, then messageStop
 * and finally metadata, which is where the token counts live.
 */
export function reassembleStream(captured) {
  const buffer = Buffer.isBuffer(captured) ? captured : Buffer.from(captured ?? '', 'binary');
  const { frames } = splitFrames(buffer);

  const message = { role: 'assistant', content: [] };
  const result = { output: { message }, stopReason: null, usage: {}, metrics: {} };
  const blocks = new Map(); // index -> { block, buffer }
  let error = null;
  let sawAnything = false;

  for (const frame of frames) {
    const type = frame.headers[':event-type'];
    const payload = frameJson(frame);

    // An exception frame carries the fault name in a header, and the message
    // in the body. Both are worth keeping — the name is the diagnostic.
    if (frame.headers[':message-type'] === 'exception' || frame.headers[':exception-type']) {
      error = { type: frame.headers[':exception-type'] ?? type ?? 'exception', ...(isObject(payload) ? payload : {}) };
      sawAnything = true;
      continue;
    }
    if (!isObject(payload)) continue;
    sawAnything = true;

    switch (type) {
      case 'messageStart':
        message.role = str(payload.role) ?? message.role;
        break;

      case 'contentBlockStart': {
        const index = int(payload.contentBlockIndex) ?? blocks.size;
        const start = isObject(payload.start) ? payload.start : {};
        const block = isObject(start.toolUse)
          ? { type: 'tool_use', id: str(start.toolUse.toolUseId), name: str(start.toolUse.name), input: {} }
          : { type: 'text', text: '' };
        blocks.set(index, { block, buffer: '' });
        break;
      }

      case 'contentBlockDelta': {
        const index = int(payload.contentBlockIndex) ?? 0;
        // Bedrock can send a delta for a block it never announced; text blocks
        // in particular often arrive with no contentBlockStart at all.
        if (!blocks.has(index)) blocks.set(index, { block: { type: 'text', text: '' }, buffer: '' });
        const entry = blocks.get(index);
        const delta = isObject(payload.delta) ? payload.delta : {};

        if (typeof delta.text === 'string') entry.block.text = (entry.block.text ?? '') + delta.text;
        else if (isObject(delta.reasoningContent) && typeof delta.reasoningContent.text === 'string') {
          entry.block.thinking = (entry.block.thinking ?? '') + delta.reasoningContent.text;
        } else if (isObject(delta.toolUse) && typeof delta.toolUse.input === 'string') {
          // Tool arguments stream as JSON text, same as Anthropic's partial_json.
          entry.buffer += delta.toolUse.input;
        }
        break;
      }

      case 'contentBlockStop': {
        const entry = blocks.get(int(payload.contentBlockIndex) ?? 0);
        if (!entry || entry.buffer === '') break;
        try {
          entry.block.input = JSON.parse(entry.buffer);
        } catch {
          // Keep the fragment rather than drop the call's arguments (§7.2.1.5).
          entry.block.input_raw = entry.buffer;
        }
        break;
      }

      case 'messageStop':
        result.stopReason = str(payload.stopReason);
        break;

      case 'metadata':
        if (isObject(payload.usage)) Object.assign(result.usage, payload.usage);
        if (isObject(payload.metrics)) Object.assign(result.metrics, payload.metrics);
        break;

      default:
        break; // not our business
    }
  }

  message.content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e.block);
  return { response: sawAnything ? result : null, error };
}

/** §06.3 — has the model started producing content? */
export function firstTokenSeen(buffered) {
  const buffer = Buffer.isBuffer(buffered) ? buffered : Buffer.from(buffered ?? '', 'binary');
  for (const frame of splitFrames(buffer).frames) {
    if (frame.headers[':event-type'] === 'contentBlockDelta') return true;
  }
  return false;
}

/** §7.4 — toolUse blocks the model emitted. */
export function extractToolUses(response) {
  const content = response?.output?.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => isObject(block) && (block.type === 'tool_use' || isObject(block.toolUse)))
    .map((block) => {
      const tool = isObject(block.toolUse) ? block.toolUse : block;
      return {
        tool_name: str(tool.name),
        tool_use_id: str(tool.toolUseId ?? tool.id),
        is_error: 0,
        content: tool.input ?? block.input ?? block.input_raw ?? null
      };
    });
}

/** §7.4 — toolResult blocks the client sent back in the conversation. */
export function extractToolResults(request) {
  if (!isObject(request) || !Array.isArray(request.messages)) return [];
  const out = [];
  for (const message of request.messages) {
    if (!isObject(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isObject(block) || !isObject(block.toolResult)) continue;
      const tr = block.toolResult;
      out.push({
        tool_name: null, // resolved from the paired toolUse when the UI renders
        tool_use_id: str(tr.toolUseId),
        is_error: tr.status === 'error' ? 1 : 0,
        content: tr.content ?? null
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
