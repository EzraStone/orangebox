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
    failures.push(`${run.unknown_cost_count} calls have unknown cost`);
  }
  return { ok: failures.length === 0, failures, maxLatency };
}
