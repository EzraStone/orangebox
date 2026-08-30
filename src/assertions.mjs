export function evaluateRunAssertions(run, calls, limits = {}) {
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
  return { ok: failures.length === 0, failures, maxLatency };
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
