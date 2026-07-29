// §21.3 — line diffing. Its own module (not in the §15 file list) so the
// algorithm is importable by the test suite; app.js touches `document` on load
// and cannot be imported from node:test.
//
// Diffing was a v2 item until REV B moved it into v1 as the headline
// differentiator. Line-level, dependency-free, and good enough to answer the
// question people actually have: what changed in the prompt between these two
// calls?

/** Above this many DP cells, report a wholesale replacement instead. */
export const LCS_CELL_BUDGET = 4_000_000;

/**
 * Diff two arrays of lines into ops of { t: '=' | '+' | '-', text }.
 *
 * Trimming the common prefix and suffix first is what makes this cheap on real
 * payloads — consecutive agent turns share almost everything except a growing
 * tail, so the LCS only ever runs on the part that actually moved.
 */
export function diffLines(aLines, bLines) {
  let start = 0;
  while (start < aLines.length && start < bLines.length && aLines[start] === bLines[start]) start++;

  let endA = aLines.length;
  let endB = bLines.length;
  while (endA > start && endB > start && aLines[endA - 1] === bLines[endB - 1]) {
    endA--;
    endB--;
  }

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ t: '=', text: aLines[i] });
  ops.push(...lcsDiff(aLines.slice(start, endA), bLines.slice(start, endB)));
  for (let i = endA; i < aLines.length; i++) ops.push({ t: '=', text: aLines[i] });
  return ops;
}

function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ t: '+', text }));
  if (m === 0) return a.map((text) => ({ t: '-', text }));

  // Pathologically large middles degrade to "replaced wholesale" rather than
  // allocating a gigabyte to be precise about it.
  if (n * m > LCS_CELL_BUDGET) {
    return [...a.map((text) => ({ t: '-', text })), ...b.map((text) => ({ t: '+', text }))];
  }

  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: '=', text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ t: '-', text: a[i] });
      i++;
    } else {
      ops.push({ t: '+', text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: '-', text: a[i++] });
  while (j < m) ops.push({ t: '+', text: b[j++] });
  return ops;
}

/**
 * Collapse long unchanged stretches into { t: 'skip', count } markers, keeping
 * `context` lines either side. A 6000-line prompt with one changed message
 * should render as a screenful, not a scroll marathon.
 */
export function collapseUnchanged(ops, context = 3) {
  const out = [];
  let run = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length <= context * 2 + 2) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, context));
      out.push({ t: 'skip', count: run.length - context * 2 });
      out.push(...run.slice(-context));
    }
    run = [];
  };

  for (const op of ops) {
    if (op.t === '=') run.push(op);
    else {
      flush();
      out.push(op);
    }
  }
  flush();
  return out;
}

/** Counts for the header: how many lines were added and removed. */
export function diffStats(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.t === '+') added++;
    else if (op.t === '-') removed++;
  }
  return { added, removed, identical: added === 0 && removed === 0 };
}
