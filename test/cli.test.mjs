// §10 — the CLI's formatting helpers. Small, but they are the layer where a
// recorded name written by somebody else meets a file somebody else parses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, truncate } from '../src/cli.mjs';

test('plain values go through the csv unquoted', () => {
  assert.equal(csvCell('claude-opus-5'), 'claude-opus-5');
  assert.equal(csvCell(42), '42');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});

test('a run name with a comma cannot shift the columns', () => {
  // Run names are typed by whoever started the run. "checkout, retry path" is
  // a perfectly reasonable name and an unquoted one silently adds a column.
  assert.equal(csvCell('checkout, retry path'), '"checkout, retry path"');
});

test('quotes in a name are doubled, per RFC 4180', () => {
  assert.equal(csvCell('the "fast" agent'), '"the ""fast"" agent"');
  assert.equal(csvCell('",injected'), '""",injected"');
});

test('a newline in a name cannot forge a new row', () => {
  // The nastier version of the comma case: an unquoted newline ends the record
  // and everything after it parses as a separate row of data.
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  assert.equal(csvCell('night run' + LF + 'fake,row,here'), '"night run' + LF + 'fake,row,here"');
  assert.equal(csvCell('a' + CR + 'b'), '"a' + CR + 'b"');
});

test('a quoted cell round-trips back to the original text', () => {
  // Parse it back the way a spreadsheet would and check nothing was lost.
  const unwrap = (cell) =>
    cell.startsWith('"') ? cell.slice(1, -1).split('""').join('"') : cell;

  const LF = String.fromCharCode(10);
  for (const original of ['plain', 'has, comma', 'has "quotes"', 'has' + LF + 'newline', '"', ',,,']) {
    assert.equal(unwrap(csvCell(original)), original, `round-trip failed for ${JSON.stringify(original)}`);
  }
});

test('long keys are ellipsised to the column width', () => {
  assert.equal(truncate('short', 20), 'short');
  const out = truncate('claude-opus-4-5-20250929-experimental', 20);
  assert.equal(out.length, 20);
  assert.ok(out.endsWith('\u2026'));
});

test('every routable provider has an upstream when started from the CLI', async () => {
  // The bug this catches shipped in 1.2.0: gemini, ollama and bedrock were
  // routable, parsed, priced and tested, yet `npx orangebox` proxied all three
  // to "undefined/v1/...". Every existing test passed because the harness
  // injects a providers map directly, which is exactly the path a real user
  // never takes.
  const { providersFrom } = await import('../src/cli.mjs');
  const { ROUTABLE_PROVIDERS } = await import('../src/server.mjs');

  const built = providersFrom({
    openaiUpstream: 'https://api.openai.com',
    anthropicUpstream: 'https://api.anthropic.com'
  });

  for (const provider of ROUTABLE_PROVIDERS) {
    const upstream = built[provider];
    assert.ok(upstream, `${provider} is routable but has no upstream`);
    assert.match(upstream, /^https?:\/\//, `${provider} upstream is not a URL: ${upstream}`);
  }
});

test('an upstream flag overrides just its own provider', async () => {
  const { providersFrom } = await import('../src/cli.mjs');
  const built = providersFrom({
    openaiUpstream: 'https://api.openai.com',
    anthropicUpstream: 'https://api.anthropic.com',
    geminiUpstream: 'http://127.0.0.1:9999'
  });

  assert.equal(built.gemini, 'http://127.0.0.1:9999');
  assert.match(built.bedrock, /bedrock-runtime/, 'the others keep their defaults');
  assert.equal(built.anthropic, 'https://api.anthropic.com');
});

test('the route pattern and the upstream table are the same list', async () => {
  // One source of truth: a provider added to PROVIDERS becomes routable, and
  // nothing can be routable without somewhere to route it to.
  const { ROUTABLE_PROVIDERS, PROVIDERS } = await import('../src/server.mjs');
  assert.deepEqual([...ROUTABLE_PROVIDERS].sort(), Object.keys(PROVIDERS).sort());
});
