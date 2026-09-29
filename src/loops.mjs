// §26 — spotting an agent that is going in circles.
//
// The most expensive agent failure is not an error, it is a loop: the model
// asks for the same tool with the same arguments, gets the same answer, and
// asks again. Nothing errors, every call succeeds, and the bill climbs. A
// timeline shows it only if you happen to read the prompts side by side.
//
// orangebox already has every prompt. This looks at them.

import crypto from 'node:crypto';

/**
 * A fingerprint of what the model was asked to do.
 *
 * Deliberately the *last* message rather than the whole conversation: an agent
 * loop resends a growing history with the same final instruction, so hashing
 * everything would make every call unique and find nothing. The last message is
 * the part that repeats.
 */
export function promptFingerprint(requestJson) {
  const parsed = parse(requestJson);
  if (!parsed) return null;

  const last = lastUserContent(parsed);
  if (last === null) return null;

  const normalised = normaliseText(last);
  if (normalised === '') return null;

  return crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

/** The text the model was last asked to act on, across provider shapes. */
function lastUserContent(request) {
  // Anthropic, OpenAI chat, Bedrock: a messages array.
  const messages = Array.isArray(request.messages) ? request.messages : null;
  if (messages && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = contentToText(messages[i]?.content);
      if (text !== '') return text;
    }
    return '';
  }

  // Gemini: contents[].parts[].text
  if (Array.isArray(request.contents) && request.contents.length > 0) {
    for (let i = request.contents.length - 1; i >= 0; i--) {
      const parts = request.contents[i]?.parts;
      if (!Array.isArray(parts)) continue;
      const text = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ').trim();
      if (text !== '') return text;
    }
    return '';
  }

  // OpenAI Responses: a bare input string, or an array of items.
  if (typeof request.input === 'string') return request.input;
  if (Array.isArray(request.input)) return contentToText(request.input);

  return null;
}

/** Content is a string, or an array of blocks, depending on the provider. */
function contentToText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (typeof block?.text === 'string') return block.text;
      // A tool result is content too, and a loop that keeps re-reading the same
      // file shows up here rather than in any prose.
      if (block?.type === 'tool_result' && block.content !== undefined) {
        return typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      }
      return '';
    })
    .join(' ')
    .trim();
}

/**
 * Whitespace and case folded away, because an agent regenerating a prompt often
 * differs only in formatting, and those are the same instruction.
 */
function normaliseText(text) {
  const whitespace = new RegExp(String.fromCharCode(92) + 's+', 'g');
  return String(text).replace(whitespace, ' ').trim().toLowerCase();
}

function parse(json) {
  if (json === null || json === undefined) return null;
  if (typeof json === 'object') return json;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Group a run's calls by what the model was asked, and report anything asked
 * more than once.
 *
 * `wasted` is the cost of every repeat after the first. It is the number worth
 * showing: the first ask was work, the rest were the loop.
 */
export function findLoops(calls, { minRepeats = 2 } = {}) {
  const groups = new Map();

  for (const call of calls) {
    const fingerprint = promptFingerprint(call.request_json);
    if (fingerprint === null) continue;

    if (!groups.has(fingerprint)) {
      groups.set(fingerprint, { fingerprint, calls: [], cost: 0, sample: null });
    }
    const group = groups.get(fingerprint);
    group.calls.push(call);
    group.cost += call.cost_usd ?? 0;
    if (group.sample === null) group.sample = summarise(call.request_json);
  }

  const loops = [...groups.values()]
    .filter((group) => group.calls.length >= minRepeats)
    .map((group) => {
      const repeats = group.calls.length - 1;
      const perCall = group.calls.length === 0 ? 0 : group.cost / group.calls.length;
      return {
        fingerprint: group.fingerprint,
        count: group.calls.length,
        repeats,
        prompt: group.sample,
        first_seq: group.calls[0].seq,
        last_seq: group.calls.at(-1).seq,
        // Consecutive repeats are a tighter signal than scattered ones: an
        // agent asking the same thing twice an hour apart is probably fine.
        consecutive: longestConsecutive(group.calls.map((c) => c.seq)),
        cost_usd: round(group.cost),
        wasted_usd: round(perCall * repeats),
        call_ids: group.calls.map((c) => c.id)
      };
    });

  loops.sort((a, b) => b.repeats - a.repeats || b.wasted_usd - a.wasted_usd);

  return {
    total_calls: calls.length,
    looping_calls: loops.reduce((sum, loop) => sum + loop.count, 0),
    wasted_usd: round(loops.reduce((sum, loop) => sum + loop.wasted_usd, 0)),
    loops
  };
}

/** The longest run of consecutive sequence numbers in a group. */
function longestConsecutive(seqs) {
  const sorted = [...seqs].sort((a, b) => a - b);
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return sorted.length === 0 ? 0 : best;
}

/** A short excerpt of the prompt, for recognising which loop this is. */
function summarise(requestJson, limit = 120) {
  const parsed = parse(requestJson);
  if (!parsed) return null;
  const text = lastUserContent(parsed);
  if (typeof text !== 'string' || text === '') return null;
  const whitespace = new RegExp(String.fromCharCode(92) + 's+', 'g');
  const flat = text.replace(whitespace, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

const round = (n) => Math.round(n * 1e6) / 1e6;
