// §30 — every check orangebox knows how to make, across runs, in one answer.
//
// Loops (§26), runaway context (§27) and cut-off answers (§29) each have their
// own command and their own banner. Each is only useful if you already suspect
// the thing it looks for. This asks the question the other way round: which of
// my runs have *anything* wrong with them, and what?

/** How much weight each finding carries when runs are ranked. */
const WEIGHT = { unanswered: 3, truncated: 3, loop: 2, growth: 1 };

/**
 * Findings for one run, from the three analyses the store already makes.
 *
 * Growth only counts when it is the kind worth acting on — steep, over enough
 * calls to mean something, and not already being served from cache. Anything
 * gentler is how multi-turn agents work, and listing it would bury the runs
 * that actually need looking at.
 */
export function findingsFor({ truncations, loops, context, weight, unanswered }) {
  const findings = [];

  // A tool the agent asked for and never got an answer to: the run finishes,
  // costs little, errors nowhere, and did not work. It shares the top weight
  // with a cut-off answer because both mean the result is wrong, not dear.
  if (unanswered?.count > 0) {
    const n = unanswered.count;
    findings.push({
      kind: 'unanswered',
      count: n,
      call_id: unanswered.call_id ?? null,
      text: `${n} tool call${n === 1 ? '' : 's'} never got a result`
    });
  }

  if (truncations?.truncated_calls > 0) {
    const n = truncations.truncated_calls;
    findings.push({
      kind: 'truncated',
      count: n,
      // The first offending call, so a finding can open straight onto it.
      call_id: truncations.calls?.[0]?.id ?? null,
      text: `${n} ${n === 1 ? 'response' : 'responses'} cut off at the output limit`
    });
  }

  if (loops?.loops?.length > 0) {
    const worst = loops.loops[0];
    findings.push({
      kind: 'loop',
      count: worst.count,
      wasted_usd: loops.wasted_usd,
      // The second time it asked — the first repeat is where it went wrong.
      call_id: worst.call_ids?.[1] ?? worst.call_ids?.[0] ?? null,
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

  const counts = { unanswered: 0, truncated: 0, loop: 0, growth: 0 };
  for (const entry of entries) for (const finding of entry.findings) counts[finding.kind] += 1;

  return {
    checked_runs: runs.length,
    flagged_runs: entries.length,
    counts,
    runs: rankDiagnoses(entries)
  };
}

/** How recent a run's last call must be for its final tool request to count as still pending. */
export const PENDING_MS = 5 * 60_000;

/**
 * Tool calls a run asked for and never answered.
 *
 * The final call's requests are forgiven while the run is fresh: an agent
 * still running has simply not sent the results yet. Anything earlier was
 * skipped over by later calls, and anything in the final call of a run that
 * has gone quiet was abandoned — which is the failure this looks for.
 */
export function unansweredTools(calls, tools, { now = Date.now() } = {}) {
  const answered = new Set(tools.filter((t) => t.kind === 'tool_result' && t.tool_use_id).map((t) => t.tool_use_id));
  const last = calls.reduce((latest, call) => ((call.seq ?? 0) > (latest?.seq ?? -1) ? call : latest), null);
  const lastActivity = last ? (last.ended_at ?? last.started_at ?? 0) : 0;
  const stillRunning = now - lastActivity < PENDING_MS;

  const open = tools.filter((t) => t.kind === 'tool_use' && (!t.tool_use_id || !answered.has(t.tool_use_id)))
    .filter((t) => !(stillRunning && last && t.call_id === last.id));

  const seqOf = new Map(calls.map((call) => [call.id, call.seq]));
  open.sort((a, b) => (seqOf.get(a.call_id) ?? 0) - (seqOf.get(b.call_id) ?? 0));
  return { count: open.length, call_id: open[0]?.call_id ?? null };
}
