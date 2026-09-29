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
