// §19.3 — Google's Generative Language API (Gemini).
//
// The most structurally different of the four, which is why it is worth having:
//
//   * The model is in the URL path, not the body:
//       /v1beta/models/gemini-2.5-pro:generateContent
//   * Streaming is a different method name rather than a body flag:
//       :streamGenerateContent  (with alt=sse for server-sent events)
//   * A turn is `contents[]` of `parts[]`, not `messages[]`, and a tool call is
//     a `functionCall` part sitting inline among the text parts.
//   * Token counts live under usageMetadata with entirely different names.
//
// Nothing above leaks past this file.
import { parseSseFrames, parseFrameJson } from './sse.mjs';

export const provider = 'gemini';

/** `/v1beta/models/{model}:{method}` — pull the model and the method apart. */
function splitEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return { model: null, method: null };
  const match = endpoint.match(/\/models\/([^:/?]+):([A-Za-z]+)/);
  if (!match) return { model: null, method: null };
  return { model: decodeURIComponent(match[1]), method: match[2] };
}

export function parseRequest(json, context = {}) {
  const { model, method } = splitEndpoint(context.endpoint);
  return {
    // The body may name the model too on some clients; the URL wins because
    // that is what actually selected the model upstream.
    model: model ?? (isObject(json) ? str(json.model) : null),
    stream: method === 'streamGenerateContent'
  };
}

export function parseResponse(json) {
  if (!isObject(json)) return emptyResult();
  const usage = isObject(json.usageMetadata) ? json.usageMetadata : {};
  const candidate = Array.isArray(json.candidates) && isObject(json.candidates[0]) ? json.candidates[0] : {};

  return {
    model: str(json.modelVersion),
    // STOP | MAX_TOKENS | SAFETY | RECITATION | OTHER, stored verbatim per §7.1.
    stop_reason: str(candidate.finishReason),
    input_tokens: int(usage.promptTokenCount),
    output_tokens: int(usage.candidatesTokenCount),
    cache_read_tokens: int(usage.cachedContentTokenCount),
    // Gemini bills cache creation separately rather than reporting it per call.
    cache_write_tokens: null
  };
}

/**
 * Fold an `alt=sse` transcript into the object `:generateContent` would return.
 * Every frame is a whole GenerateContentResponse holding the next slice, so the
 * parts accumulate rather than the frames carrying deltas of their own.
 */
export function reassembleStream(sseText) {
  let merged = null;
  let error = null;
  let sawAnything = false;

  const parts = [];
  let text = '';
  let finishReason = null;
  let usage = null;

  for (const frame of parseSseFrames(sseText)) {
    const payload = parseFrameJson(frame.data);
    if (!isObject(payload)) continue;
    sawAnything = true;

    if (payload.error) {
      error = payload.error;
      continue;
    }

    merged = { ...(merged ?? {}), ...payload };
    if (isObject(payload.usageMetadata)) usage = payload.usageMetadata;

    const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : null;
    if (!isObject(candidate)) continue;
    if (str(candidate.finishReason)) finishReason = str(candidate.finishReason);

    const content = isObject(candidate.content) ? candidate.content : null;
    for (const part of Array.isArray(content?.parts) ? content.parts : []) {
      if (!isObject(part)) continue;
      if (typeof part.text === 'string') text += part.text;
      // functionCall parts arrive whole; they are never split across frames.
      else parts.push(part);
    }
  }

  if (!sawAnything) return { response: null, error };

  const assembled = [...(text !== '' ? [{ text }] : []), ...parts];

  return {
    response: {
      ...(merged ?? {}),
      candidates: [
        {
          content: { role: 'model', parts: assembled },
          finishReason
        }
      ],
      ...(usage ? { usageMetadata: usage } : {})
    },
    error
  };
}

/** §06.3 — first content on the wire is the first frame carrying any part. */
export function firstTokenSeen(buffered) {
  for (const frame of parseSseFrames(buffered)) {
    const payload = parseFrameJson(frame.data);
    const parts = payload?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts) && parts.length > 0) return true;
  }
  return false;
}

/** §7.4 — functionCall parts, which sit inline among the text parts. */
export function extractToolUses(response) {
  if (!isObject(response) || !Array.isArray(response.candidates)) return [];
  const parts = response.candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) return [];

  let index = 0;
  return parts
    .filter((part) => isObject(part) && isObject(part.functionCall))
    .map((part) => {
      const name = str(part.functionCall.name);
      return {
        tool_name: name,
        // Gemini issues no call id; the client pairs on name and order.
        tool_use_id: name ? `${name}#${index++}` : null,
        is_error: 0,
        content: part.functionCall.args ?? null
      };
    });
}

/** §7.4 — functionResponse parts the client sent back in `contents`. */
export function extractToolResults(request) {
  if (!isObject(request) || !Array.isArray(request.contents)) return [];
  const out = [];
  let index = 0;

  for (const turn of request.contents) {
    if (!isObject(turn) || !Array.isArray(turn.parts)) continue;
    for (const part of turn.parts) {
      if (!isObject(part) || !isObject(part.functionResponse)) continue;
      const name = str(part.functionResponse.name);
      out.push({
        tool_name: name,
        tool_use_id: name ? `${name}#${index++}` : null,
        is_error: 0,
        content: part.functionResponse.response ?? null
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
