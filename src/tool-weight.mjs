// §31 — which tools the prompt is carrying.
//
// Context growth (§27) says a prompt got big. The usual reason is a tool
// result: a file read, a search, a page fetched. It lands in the history once
// and is then re-sent on every later call in the run, so a 20k-token result
// read at call 3 of 30 is paid for twenty-eight times. The cost of a tool is
// not its size, it is its size times how long the conversation carries it.
//
// Sizes are estimates. orangebox has token counts per call, not per message,
// so a result's tokens are approximated from its stored bytes at the usual
// four-to-one. The stored content is capped at 256 KB per result and has
// base64 payloads stripped, so a huge result or an image is under-counted.
// Every figure here is labelled an estimate for exactly that reason.

const BYTES_PER_TOKEN = 4;

/** Rough tokens for a stored JSON value. */
export function estimateTokens(json) {
  if (typeof json !== 'string' || json === '') return 0;
  return Math.ceil(Buffer.byteLength(json) / BYTES_PER_TOKEN);
}

/**
 * How much each tool's results weighed on the run's prompts.
 *
 * `carried_tokens` is the result's size times the number of calls that sent
 * it: the one it arrived in plus every call after. That is the figure that
 * explains a bill; `tokens` alone explains nothing about one.
 */
export function toolWeight(calls, tools) {
  const seqByCall = new Map(calls.map((call) => [call.id, call.seq]));
  const lastSeq = calls.reduce((max, call) => Math.max(max, call.seq ?? 0), 0);

  // Results do not name their tool; the tool_use that asked for them does.
  const nameByUse = new Map();
  for (const event of tools) {
    if (event.kind === 'tool_use' && event.tool_use_id) nameByUse.set(event.tool_use_id, event.tool_name);
  }

  const byTool = new Map();
  let carried = 0;
  let results = 0;

  for (const event of tools) {
    if (event.kind !== 'tool_result') continue;
    const seq = seqByCall.get(event.call_id);
    if (seq === undefined) continue;

    const tokens = estimateTokens(event.content_json);
    const sends = 1 + Math.max(0, lastSeq - seq);
    const name = event.tool_name ?? nameByUse.get(event.tool_use_id) ?? '(unnamed tool)';

    const entry = byTool.get(name) ?? { tool: name, results: 0, tokens: 0, carried_tokens: 0, largest_tokens: 0 };
    entry.results += 1;
    entry.tokens += tokens;
    entry.carried_tokens += tokens * sends;
    entry.largest_tokens = Math.max(entry.largest_tokens, tokens);
    byTool.set(name, entry);

    carried += tokens * sends;
    results += 1;
  }

  const sent = calls.reduce((sum, call) => sum + (Number.isFinite(call.input_tokens) ? call.input_tokens : 0)
    + (Number.isFinite(call.cache_read_tokens) ? call.cache_read_tokens : 0), 0);

  return {
    estimated: true,
    results,
    carried_tokens: carried,
    // Capped, like the cached share: an estimate of part of a total must not
    // read as more than the whole of it.
    share_of_input: sent === 0 ? null : Math.min(1, carried / sent),
    tools: [...byTool.values()].sort((a, b) => b.carried_tokens - a.carried_tokens)
  };
}
