// §27 — how much of what you paid for was the same conversation, again.
//
// An agent turn re-sends the whole history. By the twentieth call the prompt
// may be forty times the size of the first, and every one of those tokens is
// billed. That is not a bug — it is how the APIs work — but it is the largest
// line on most agent bills, and prompt caching exists precisely to blunt it.
//
// orangebox records input tokens and cache reads on every call, so it can say
// how much of a run was fresh context and how much was re-reading.

/**
 * Context growth across a run.
 *
 * `cached_share` is the fraction of input tokens the provider billed at the
 * cache rate. A run with heavy growth and no cache reads is the one worth
 * looking at: the same tokens, resent at full price, every turn.
 */
export function contextGrowth(calls) {
  const sized = calls
    .filter((call) => Number.isFinite(call.input_tokens) && call.input_tokens > 0)
    .sort((a, b) => a.seq - b.seq);

  if (sized.length === 0) {
    return {
      calls: 0, first_tokens: null, last_tokens: null, peak_tokens: null,
      total_input_tokens: 0, cached_tokens: 0, cached_share: null,
      growth: null, verdict: 'no token counts recorded'
    };
  }

  const first = sized[0].input_tokens;
  const last = sized.at(-1).input_tokens;
  const peak = Math.max(...sized.map((c) => c.input_tokens));
  const total = sized.reduce((sum, c) => sum + c.input_tokens, 0);
  const cached = sized.reduce((sum, c) => sum + (c.cache_read_tokens ?? 0), 0);

  // Cache reads are reported separately from input tokens by some providers and
  // included by others, so the share is capped rather than allowed past 1 —
  // a "137% cached" figure would rightly destroy trust in the whole number.
  const share = total === 0 ? null : Math.min(1, cached / total);
  const growth = first === 0 ? null : peak / first;

  return {
    calls: sized.length,
    first_tokens: first,
    last_tokens: last,
    peak_tokens: peak,
    total_input_tokens: total,
    cached_tokens: cached,
    cached_share: share,
    growth,
    verdict: verdictFor({ growth, share, calls: sized.length })
  };
}

/**
 * One sentence about whether this is worth acting on.
 *
 * Deliberately conservative: a short run that grew is just a conversation, and
 * saying "consider prompt caching" about three calls would be noise that
 * teaches people to ignore the line.
 */
function verdictFor({ growth, share, calls }) {
  if (growth === null) return 'context size is not knowable from these calls';
  if (calls < 4) return 'too few calls to say much';

  if (growth >= 5 && (share ?? 0) < 0.25) {
    return 'the prompt grew sharply and almost none of it was cached — prompt caching would pay here';
  }
  if (growth >= 5) return 'the prompt grew sharply, but most of it was served from cache';
  if (growth >= 2) return 'the prompt roughly doubled over the run, which is normal for a multi-turn agent';
  return 'the prompt stayed about the same size';
}
