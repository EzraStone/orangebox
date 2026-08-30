// §19.7 — replay credentials. Nothing here should ever surface a secret's
// value; the module's whole job is to name variables and set one header.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCredential,
  missingCredentialMessage,
  PROVIDER_CREDENTIALS
} from '../src/credentials.mjs';

test('every routable provider has a credential mapping (§19.3)', () => {
  // The bug this module exists to fix: gemini and bedrock shipped as proxy
  // routes while replay still only knew about anthropic and openai, so their
  // replays went out unauthenticated and came back 401 with no explanation.
  for (const provider of ['anthropic', 'openai', 'gemini', 'ollama', 'bedrock']) {
    assert.ok(PROVIDER_CREDENTIALS[provider], `${provider} has no mapping`);
  }
});

test('each provider puts its key in the header that provider expects', () => {
  assert.equal(
    resolveCredential('anthropic', { ANTHROPIC_API_KEY: 'sk-ant-x' }).headers['x-api-key'],
    'sk-ant-x'
  );
  assert.equal(
    resolveCredential('openai', { OPENAI_API_KEY: 'sk-o' }).headers.authorization,
    'Bearer sk-o'
  );
  assert.equal(
    resolveCredential('gemini', { GEMINI_API_KEY: 'g-key' }).headers['x-goog-api-key'],
    'g-key'
  );
  assert.equal(
    resolveCredential('bedrock', { AWS_BEARER_TOKEN_BEDROCK: 'brk' }).headers.authorization,
    'Bearer brk'
  );
});

test('anthropic replays carry a version header, defaulting when unset', () => {
  assert.equal(
    resolveCredential('anthropic', { ANTHROPIC_API_KEY: 'k' }).headers['anthropic-version'],
    '2023-06-01'
  );
});

test('the first variable that is set wins', () => {
  const both = resolveCredential('gemini', { GEMINI_API_KEY: 'first', GOOGLE_API_KEY: 'second' });
  assert.equal(both.headers['x-goog-api-key'], 'first');
  assert.equal(both.source, 'GEMINI_API_KEY');

  const fallback = resolveCredential('gemini', { GOOGLE_API_KEY: 'second' });
  assert.equal(fallback.headers['x-goog-api-key'], 'second');
  assert.equal(fallback.source, 'GOOGLE_API_KEY');
});

test('a blank or whitespace variable counts as unset', () => {
  // An empty env var is a very common way to end up sending "Bearer " and
  // getting a 401 that looks like a bad key rather than a missing one.
  for (const value of ['', '   ']) {
    const result = resolveCredential('openai', { OPENAI_API_KEY: value });
    assert.equal(result.ok, false, `"${value}" should not count as a key`);
  }
  assert.equal(resolveCredential('openai', { OPENAI_API_KEY: '  sk-padded  ' }).headers.authorization, 'Bearer sk-padded');
});

test('ollama needs no key and is not blocked for lacking one', () => {
  // Local inference has nothing to authenticate against. Requiring a key here
  // would break replay for the one provider that never needs one.
  const result = resolveCredential('ollama', {});
  assert.equal(result.ok, true);
  assert.equal(result.required, false);
  assert.deepEqual(result.headers, {});
});

test('a missing key fails closed, naming what to set', () => {
  const result = resolveCredential('gemini', {});
  assert.equal(result.ok, false);
  assert.equal(result.source, null);
  assert.deepEqual(result.checked, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']);

  const message = missingCredentialMessage(result);
  assert.match(message, /GEMINI_API_KEY, or GOOGLE_API_KEY|GEMINI_API_KEY or GOOGLE_API_KEY/);
  assert.match(message, /does not store credentials/);
});

test('an unknown provider is refused rather than guessed at', () => {
  const result = resolveCredential('nonesuch', {});
  assert.equal(result.ok, false);
  assert.equal(result.unknown, true);
  assert.match(missingCredentialMessage(result), /no credential mapping/);
});

test('prototype keys do not resolve to a credential mapping', () => {
  // Same lesson as the spend grouping whitelist: a bare lookup would return
  // Object.prototype.constructor here and sail past a truthiness check.
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const result = resolveCredential(key, {});
    assert.equal(result.ok, false, `${key} must not resolve`);
    assert.equal(result.unknown, true);
  }
});

test('nothing but the header carries the secret', () => {
  // checked/source are safe to log or render; a value must never ride along.
  const result = resolveCredential('openai', { OPENAI_API_KEY: 'sk-secret-value' });
  const withoutHeaders = JSON.stringify({ ...result, headers: undefined });
  assert.doesNotMatch(withoutHeaders, /sk-secret-value/);
  assert.doesNotMatch(missingCredentialMessage({ ...result, ok: false }) ?? '', /sk-secret-value/);
});

test('a key is only demanded when the provider still points at its own cloud', async () => {
  // The rule that keeps replay working against a local gateway. Someone who
  // set --anthropic-upstream to a vLLM on their laptop configured that
  // endpoint themselves; orangebox has no business insisting on a key for it.
  const { credentialRequired } = await import('../src/credentials.mjs');
  const defaults = {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com',
    ollama: 'http://127.0.0.1:11434'
  };

  assert.equal(credentialRequired('anthropic', 'https://api.anthropic.com', defaults), true);
  assert.equal(credentialRequired('anthropic', 'http://127.0.0.1:8000', defaults), false);
  assert.equal(credentialRequired('openai', 'https://openrouter.ai/api', defaults), false);

  // Ollama never needs one, default upstream or not.
  assert.equal(credentialRequired('ollama', 'http://127.0.0.1:11434', defaults), false);

  // Unknown providers and missing config are not grounds to block.
  assert.equal(credentialRequired('nonesuch', 'https://x', defaults), false);
  assert.equal(credentialRequired('anthropic', undefined, defaults), false);
  assert.equal(credentialRequired('anthropic', 'https://api.anthropic.com', undefined), false);
});
