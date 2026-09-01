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

test('`run` points every recordable provider at the run-scoped prefix', async () => {
  // The gap this closes: only ANTHROPIC_BASE_URL and OPENAI_BASE_URL were set,
  // so wrapping a Gemini or Ollama agent produced an empty run while reporting
  // that it was recording — the provider-routing bug again, in another file.
  const { runScopedEnv } = await import('../src/cli.mjs');
  const { ROUTABLE_PROVIDERS } = await import('../src/server.mjs');

  const env = runScopedEnv('http://127.0.0.1:4100', 'run-1');
  const urls = Object.values(env);

  for (const provider of ROUTABLE_PROVIDERS) {
    assert.ok(
      urls.some((url) => url.endsWith(`/r/run-1/${provider}`)),
      `no environment variable points at ${provider}`
    );
  }
});

test('run ids with awkward characters are escaped into the url', () => {
  // Run ids are generated, but a caller can supply one via the header, and an
  // unescaped slash would silently reroute the agent to a different provider.
  return import('../src/cli.mjs').then(({ runScopedEnv }) => {
    const env = runScopedEnv('http://x', 'a b/c');
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://x/r/a%20b%2Fc/anthropic');
  });
});

test('every command the CLI dispatches is in --help', async () => {
  // The recurring failure in this codebase is two lists that drift: routes and
  // upstreams, providers and env vars, docs and code. This is the same shape —
  // a command nobody can discover is a command that does not exist.
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');

  const dispatchStart = source.indexOf('export async function main(');
  const dispatchEnd = source.indexOf('}', source.indexOf('default:', dispatchStart));
  const dispatch = source.slice(dispatchStart, dispatchEnd);

  const commands = [...dispatch.matchAll(/case '([a-z]+)':/g)]
    .map((m) => m[1])
    .filter((name) => !['help', 'version'].includes(name));

  assert.ok(commands.length >= 10, `only found ${commands.length} commands to check`);

  const helpStart = source.indexOf('USAGE');
  const help = source.slice(helpStart, helpStart + 2000);

  for (const command of commands) {
    assert.ok(
      help.includes(`orangebox ${command}`) || help.includes(`orangebox [${command}]`),
      `"${command}" is dispatched but never appears in --help`
    );
  }
});
