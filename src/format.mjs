// One rule for printing a token count, because there were three.
//
// The CLI, the HTML report and the web UI each grew their own, and two of them
// disagreed across most of the range anybody looks at: 24,500 tokens read as
// "24.5k" in the terminal and "25k" in the browser, for the same number on the
// same run. A reader who notices that stops trusting both.
//
// The browser cannot import this file — ui/ is served as static assets and has
// no build step — so ui/dom.js keeps its own copy and a test asserts the two
// agree across a table of values. One rule, two implementations, checked.

/**
 * A token count, at the precision that is useful for comparing two of them.
 *
 * Exact below ten thousand: token counts are countable at that scale, and
 * "1.2k" throws away digits that cost nothing to keep. Rounded above it,
 * because nobody compares 147,382 against 22,904 without first rounding them
 * in their head anyway.
 */
export function formatTokens(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value < 10_000) return String(value);

  // 999,999 would otherwise print as "1000k", which is a unit nobody uses and
  // reads as ten times its value at a glance.
  if (value < 999_500) return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * An estimated cost, at the precision the number deserves.
 *
 * Four decimals below a cent, because a run costing $0.0003 is a real answer
 * and "$0.00" is not. Two above a dollar, because nobody reads the
 * hundredths of a cent on a twelve-dollar bill — and the HTML report printed
 * "$1234.5000" for months, which looks like a precision claim nobody is making.
 *
 * Zero is "$0" rather than "$0.0000": a local model really does cost nothing
 * (§08), and four decimals of nothing reads like a rounding error.
 */
export function formatUsd(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}
