// CONTRIBUTING lists eleven places a provider has to be registered. The ones
// that were not already checked somewhere closer to their code are checked
// here, each derived from the routing table, so the list cannot claim a test
// that does not exist.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ROUTABLE_PROVIDERS } from '../src/server.mjs';
import { PARSERS } from '../src/proxy.mjs';
import { loadPricing, LOCAL_PROVIDERS } from '../src/pricing.mjs';

test('every routable provider has a parser', () => {
  // Without one the call is proxied fine and recorded as nothing: no model,
  // no tokens, no tool events, and no error to say why.
  for (const provider of ROUTABLE_PROVIDERS) {
    assert.ok(PARSERS[provider], `no parser registered for ${provider}`);
    for (const fn of ['parseRequest', 'parseResponse', 'reassembleStream', 'firstTokenSeen', 'extractToolUses', 'extractToolResults']) {
      assert.equal(typeof PARSERS[provider][fn], 'function', `${provider} parser has no ${fn}`);
    }
  }
});

/**
 * One model each provider really serves, as its responses name it. Not the
 * whole catalogue — the point is that a provider added with no pricing at all
 * fails here, rather than recording every call as "unpriced" forever.
 */
const REPRESENTATIVE_MODEL = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-5.6-sol',
  gemini: 'gemini-2.5-pro',
  // An inference-profile id as Bedrock returns it, region prefix and all.
  bedrock: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  ollama: 'llama3.2'
};

test('every routable provider has at least one priced model', () => {
  assert.deepEqual(Object.keys(REPRESENTATIVE_MODEL).sort(), [...ROUTABLE_PROVIDERS].sort(),
    'name a representative model for every routable provider');

  const pricing = loadPricing({ userFile: null });
  for (const [provider, model] of Object.entries(REPRESENTATIVE_MODEL)) {
    // Local inference costs nothing by rule rather than by table entry (§08).
    if (LOCAL_PROVIDERS.has(provider)) {
      assert.equal(pricing.costFor({ provider, model, input_tokens: 10, output_tokens: 10 }), 0);
      continue;
    }
    assert.ok(pricing.rateFor(model), `${provider}: ${model} has no rate in pricing.json`);
  }
});
