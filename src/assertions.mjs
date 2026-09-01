/**
 * §19.6 — decide whether a recorded run should fail a build.
 *
 * `tools` is optional: callers that only have calls still work, and the
 * tool-shaped limits simply do not fire.
 */
export function evaluateRunAssertions(run, calls, limits = {}, tools = []) {
  const failures = [];
  const maxLatency = Math.max(0, ...calls.map((call) => call.latency_ms ?? 0));
  if (limits.maxCost != null && run.cost_usd > limits.maxCost) {
    failures.push(`cost $${run.cost_usd.toFixed(6)} exceeds $${limits.maxCost}`);
  }
  if (limits.maxLatency != null && maxLatency > limits.maxLatency) {
    failures.push(`max latency ${maxLatency} ms exceeds ${limits.maxLatency} ms`);
  }
  if (limits.maxErrors != null && run.error_count > limits.maxErrors) {
    failures.push(`${run.error_count} errors exceeds ${limits.maxErrors}`);
  }
  if (limits.maxCalls != null && run.call_count > limits.maxCalls) {
    failures.push(`${run.call_count} calls exceeds ${limits.maxCalls}`);
  }
  if (limits.requireKnownCost && run.unknown_cost_count > 0) {
    // "unknown cost" covers two situations with opposite remedies, and a CI
    // log is exactly where you cannot ask a follow-up question. Say which.
    const { unrated, noUsage } = splitUnknownCost(calls);
    const why = [];
    if (unrated > 0) why.push(`${unrated} with no pricing entry for their model`);
    if (noUsage > 0) why.push(`${noUsage} reporting no token counts`);
    failures.push(
      why.length
        ? `${run.unknown_cost_count} calls have unknown cost (${why.join('; ')})`
        : `${run.unknown_cost_count} calls have unknown cost`
    );
  }
  // Tool-shaped failures. An agent whose tool calls never come back is
  // broken in a way none of the limits above can see: the run finishes,
  // costs little, errors zero times, and did not work.
  const toolCounts = countToolOutcomes(tools);

  if (limits.maxToolErrors != null && toolCounts.errors > limits.maxToolErrors) {
    failures.push(`${toolCounts.errors} tool error(s) exceeds ${limits.maxToolErrors}`);
  }
  if (limits.maxUnansweredTools != null && toolCounts.unanswered > limits.maxUnansweredTools) {
    failures.push(
      `${toolCounts.unanswered} tool call(s) never got a result, which exceeds ${limits.maxUnansweredTools}` +
        ' — the agent loop did not complete'
    );
  }

  return { ok: failures.length === 0, failures, maxLatency, tools: toolCounts };
}

/**
 * Tool outcomes for a run: how many were asked for, how many failed, and how
 * many never got an answer at all.
 */
export function countToolOutcomes(tools = []) {
  const uses = tools.filter((t) => t.kind === 'tool_use');
  const results = tools.filter((t) => t.kind === 'tool_result');
  const answered = new Set(results.map((r) => r.tool_use_id).filter(Boolean));

  return {
    uses: uses.length,
    errors: results.filter((r) => r.is_error === 1 || r.is_error === true).length,
    unanswered: uses.filter((u) => !u.tool_use_id || !answered.has(u.tool_use_id)).length
  };
}

/**
 * Why a call's cost is null: no rate for the model, or no usage to price.
 * Derived from the calls rather than stored, so it needs no schema change and
 * cannot drift out of step with the rows it describes.
 */
export function splitUnknownCost(calls = []) {
  let unrated = 0;
  let noUsage = 0;

  for (const call of calls) {
    if (call.cost_usd !== null && call.cost_usd !== undefined) continue;
    const reported =
      call.input_tokens != null ||
      call.output_tokens != null ||
      call.cache_read_tokens != null ||
      call.cache_write_tokens != null;
    if (reported) unrated += 1;
    else noUsage += 1;
  }

  return { unrated, noUsage };
}
