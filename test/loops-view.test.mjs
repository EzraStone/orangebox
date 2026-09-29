// §26 — the loop banner's wording.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/** loopSummary is pure; lift it out of app.js rather than duplicating it. */
function loadSummary() {
  const source = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function loopSummary(');
  assert.ok(start >= 0, 'loopSummary not found in app.js');
  const end = source.indexOf('\n}', start) + 2;
  return new Function(`${source.slice(start, end).replace('export function', 'function')}; return loopSummary;`)();
}

const loopSummary = loadSummary();

test('a run with no loops gets no banner', () => {
  // Silence is the right answer here: a banner saying "no loops" on every
  // healthy run is a banner people stop reading.
  assert.equal(loopSummary(null), null);
  assert.equal(loopSummary({ loops: [] }), null);
  assert.equal(loopSummary({}), null);
});

test('a tight loop says how many were back to back', () => {
  const summary = loopSummary({
    wasted_usd: 0.09,
    loops: [{ count: 6, consecutive: 6, prompt: 'check the deploy', repeats: 5 }]
  });
  assert.match(summary.headline, /6 calls asked the same thing/);
  assert.match(summary.headline, /6 of them back to back/);
  assert.equal(summary.prompt, 'check the deploy');
  assert.equal(summary.wasted, 0.09);
});

test('a scattered repeat is described differently from a tight one', () => {
  // Six in a row is an agent stuck. Three spread across a run is an agent
  // asking twice. Reading the same sentence for both would be wrong.
  const scattered = loopSummary({
    wasted_usd: 0.02,
    loops: [{ count: 3, consecutive: 1, prompt: 'status?', repeats: 2 }]
  });
  assert.match(scattered.headline, /spread through the run/);
  assert.doesNotMatch(scattered.headline, /back to back/);
});

test('further loops are counted rather than listed', () => {
  const summary = loopSummary({
    wasted_usd: 0.5,
    loops: [
      { count: 4, consecutive: 4, prompt: 'first', repeats: 3 },
      { count: 2, consecutive: 2, prompt: 'second', repeats: 1 },
      { count: 2, consecutive: 1, prompt: 'third', repeats: 1 }
    ]
  });
  assert.equal(summary.others, 2);
  assert.equal(summary.prompt, 'first', 'the worst one is the one shown');
});

test('a loop with no readable prompt still produces a banner', () => {
  // The count is the useful part; a missing excerpt must not suppress it.
  const summary = loopSummary({ wasted_usd: 0, loops: [{ count: 3, consecutive: 3, prompt: null, repeats: 2 }] });
  assert.ok(summary.headline);
  assert.equal(summary.prompt, null);
});
