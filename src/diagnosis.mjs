// §30 — every check orangebox knows how to make, across runs, in one answer.
//
// Loops (§26), runaway context (§27) and cut-off answers (§29) each have their
// own command and their own banner. Each is only useful if you already suspect
// the thing it looks for. This asks the question the other way round: which of
// my runs have *anything* wrong with them, and what?

/** How much weight each finding carries when runs are ranked. */
const WEIGHT = { truncated: 3, loop: 2, growth: 1 };

/**
 * Findings for one run, from the three analyses the store already makes.
 *
 * Growth only counts when it is the kind worth acting on — steep, over enough
 * calls to mean something, and not already being served from cache. Anything
 * gentler is how multi-turn agents work, and listing it would bury the runs
 * that actually need looking at.
 */
export function findingsFor({ truncations, loops, context, weight }) {
  const findings = [];

  if (truncations?.truncated_calls > 0) {
    const n = truncations.truncated_calls;
    findings.push({
      kind: 'truncated',
      count: n,
      text: `${n} ${n === 1 ? 'response' : 'responses'} cut off at the output limit`
    });
  }

  if (loops?.loops?.length > 0) {
    const worst = loops.loops[0];
    findings.push({
      kind: 'loop',
      count: worst.count,
      wasted_usd: loops.wasted_usd,
      text: `${worst.count} calls asked the same thing`
    });
  }

  if (context && context.calls >= 4 && context.growth >= 5 && (context.cached_share ?? 0) < 0.25) {
    // §31 — say what it grew with, when one tool clearly is the answer. The
    // finding is the thing someone acts on, and "cache it" and "stop
    // re-reading that file" are different actions.
    const culprit = dominantTool(weight);
    findings.push({
      kind: 'growth',
      growth: context.growth,
      tool: culprit,
      text: `prompt grew ${context.growth.toFixed(1)}× with almost nothing cached`
        + (culprit ? `, mostly re-sent ${culprit} results` : '')
    });
  }

  return findings;
}

/** The tool that carried most of what tool results carried, if one did. */
export function dominantTool(weight) {
  if (!weight?.carried_tokens || !weight.tools?.length) return null;
  const [top] = weight.tools;
  return top.carried_tokens / weight.carried_tokens >= 0.5 ? top.tool : null;
}

/** Most serious first: the weight of what was found, then how recent. */
export function rankDiagnoses(entries) {
  const score = (entry) => entry.findings.reduce((sum, f) => sum + WEIGHT[f.kind], 0);
  return [...entries].sort((a, b) => score(b) - score(a) || (b.run.started_at ?? 0) - (a.run.started_at ?? 0));
}

/**
 * Diagnose a set of runs. `analyse(runId)` returns the three analyses for one
 * run; passing it in keeps this module free of the store and trivially tested.
 */
export function diagnose(runs, analyse) {
  const entries = [];
  for (const run of runs) {
    const findings = findingsFor(analyse(run.id));
    if (findings.length > 0) entries.push({ run, findings });
  }

  const counts = { truncated: 0, loop: 0, growth: 0 };
  for (const entry of entries) for (const finding of entry.findings) counts[finding.kind] += 1;

  return {
    checked_runs: runs.length,
    flagged_runs: entries.length,
    counts,
    runs: rankDiagnoses(entries)
  };
}
