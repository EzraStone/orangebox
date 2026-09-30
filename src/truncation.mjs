// §29 — responses the model did not finish.
//
// A call that stopped because it hit its output limit is a failure that passes
// every other check: the status is 200, nothing errored, the cost is ordinary,
// and the agent carries on with half an answer. When the half is a tool call,
// it carries on with arguments cut off mid-JSON, and the error that follows
// points at the tool rather than at the limit that caused it.
//
// Every provider says "I ran out of room" differently, and orangebox stores the
// stop reason verbatim (§7.1), so the translation lives here — in one place,
// checked per provider by test/truncation.test.mjs.

/**
 * The stop reasons that mean "cut off by the output limit", by provider.
 *
 * Kept per provider rather than as one flat set so the test can insist every
 * routable provider has stated its answer. A sixth provider added without an
 * entry here would record its truncations as ordinary stops, silently.
 */
export const TRUNCATION_REASONS = {
  anthropic: ['max_tokens'],
  openai: ['length', 'max_output_tokens'],
  gemini: ['MAX_TOKENS'],
  ollama: ['length'],
  bedrock: ['max_tokens']
};

const ANY = new Set(Object.values(TRUNCATION_REASONS).flat());

/**
 * Did this call stop because it ran out of output room?
 *
 * The provider is used when it is known, so that a reason meaning something
 * else elsewhere cannot be misread; without one, any provider's spelling
 * counts, because an imported run from an older export may not carry it.
 */
export function isTruncated(stopReason, provider = null) {
  if (typeof stopReason !== 'string' || stopReason === '') return false;
  const known = provider && Object.hasOwn(TRUNCATION_REASONS, provider) ? TRUNCATION_REASONS[provider] : null;
  return known ? known.includes(stopReason) : ANY.has(stopReason);
}

/**
 * The truncated calls in a run, and how much of the run they are.
 *
 * `at_limit` counts the ones that also asked for tools. Those are the dangerous
 * ones: a truncated sentence is visibly short, a truncated tool call is
 * malformed JSON the agent will try to run.
 */
export function findTruncations(calls) {
  const answered = calls.filter((call) => typeof call.stop_reason === 'string' && call.stop_reason !== '');
  const truncated = answered
    .filter((call) => isTruncated(call.stop_reason, call.provider))
    .sort((a, b) => a.seq - b.seq);

  return {
    total_calls: calls.length,
    answered_calls: answered.length,
    truncated_calls: truncated.length,
    share: answered.length === 0 ? 0 : truncated.length / answered.length,
    calls: truncated.map((call) => ({
      id: call.id,
      seq: call.seq,
      provider: call.provider,
      model: call.model ?? null,
      stop_reason: call.stop_reason,
      output_tokens: call.output_tokens ?? null
    }))
  };
}
