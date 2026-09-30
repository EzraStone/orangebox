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
 * Where each provider's request says how long an answer may be, as paths
 * into the request body, first match wins.
 *
 * Naming the parameter is the useful half of reporting a truncation: "cut
 * off" says something went wrong, "max_completion_tokens was 4096" says what
 * to change. Kept per provider, like the reasons, so a sixth provider has to
 * state its answer here too.
 */
export const OUTPUT_LIMIT_FIELDS = {
  anthropic: [['max_tokens']],
  // Chat Completions renamed the field; old clients still send the old one.
  // The Responses API has a third name of its own.
  openai: [['max_completion_tokens'], ['max_output_tokens'], ['max_tokens']],
  gemini: [['generationConfig', 'maxOutputTokens']],
  ollama: [['options', 'num_predict']],
  bedrock: [['inferenceConfig', 'maxTokens']]
};

/**
 * The output limit a request asked for, and the name it used — or null
 * when the request set none, which for most providers means a default the
 * provider chose and orangebox cannot see.
 */
export function requestedLimit(provider, request) {
  const paths = Object.hasOwn(OUTPUT_LIMIT_FIELDS, provider) ? OUTPUT_LIMIT_FIELDS[provider] : [];
  let body = request;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return null; }
  }
  if (!body || typeof body !== 'object') return null;

  for (const path of paths) {
    let value = body;
    for (const key of path) value = value && typeof value === 'object' ? value[key] : undefined;
    if (Number.isFinite(value)) return { field: path.join('.'), value };
  }
  return null;
}

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
      output_tokens: call.output_tokens ?? null,
      // Only when the request body is at hand; summaries do not carry it.
      limit: 'request_json' in call ? requestedLimit(call.provider, call.request_json) : null
    }))
  };
}
