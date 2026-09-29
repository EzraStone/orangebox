// §7.1/§08 — one meaning for input_tokens, across five providers.
//
// Providers disagree about whether a reported prompt total already contains
// the tokens served from cache. Anthropic and Bedrock report them separately;
// Gemini and OpenAI fold them in. orangebox normalises: input_tokens is the
// part billed at the full input rate, and cache_read_tokens sits beside it.
//
// Without that, §08 either bills the cached share twice or prices it at full
// rate, and both bugs have been in this file's history.
import test from 'node:test';
import assert from 'node:assert/strict';

import * as anthropic from '../src/parse/anthropic.mjs';
import * as openai from '../src/parse/openai.mjs';
import * as gemini from '../src/parse/gemini.mjs';
import * as ollama from '../src/parse/ollama.mjs';
import * as bedrock from '../src/parse/bedrock.mjs';
import { ROUTABLE_PROVIDERS } from '../src/server.mjs';

/**
 * A response from each provider whose prompt was 10,000 tokens, of which 8,000
 * came from cache — written in that provider's own spelling and convention.
 */
const CASES = {
  anthropic: {
    parser: anthropic,
    // Reports the uncached part in input_tokens already.
    response: { model: 'claude-opus-5', usage: { input_tokens: 2000, output_tokens: 50, cache_read_input_tokens: 8000 } }
  },
  openai: {
    parser: openai,
    // input_tokens is the whole prompt, cached tokens included.
    response: {
      object: 'response', model: 'gpt-5.6-sol', status: 'completed', output: [],
      usage: { input_tokens: 10000, output_tokens: 50, input_tokens_details: { cached_tokens: 8000 } }
    }
  },
  gemini: {
    parser: gemini,
    // "the total effective prompt size ... includes the cached content".
    response: {
      modelVersion: 'gemini-2.5-pro',
      usageMetadata: { promptTokenCount: 10000, candidatesTokenCount: 50, cachedContentTokenCount: 8000 }
    }
  },
  bedrock: {
    parser: bedrock,
    // AWS reports cache reads outside inputTokens, as Anthropic does.
    response: { stopReason: 'end_turn', usage: { inputTokens: 2000, outputTokens: 50, cacheReadInputTokens: 8000 } }
  },
  ollama: {
    parser: ollama,
    // Local inference has no cache accounting at all; the whole prompt is the
    // prompt, and there is no per-token bill either way.
    response: { model: 'llama3.2', done: true, prompt_eval_count: 10000, eval_count: 50 },
    cached: 0
  }
};

test('every routable provider is covered here', () => {
  // The recurring failure in this codebase is a list extended in one place.
  assert.deepEqual(Object.keys(CASES).sort(), [...ROUTABLE_PROVIDERS].sort());
});

for (const [name, { parser, response, cached = 8000 }] of Object.entries(CASES)) {
  test(`${name}: input_tokens is the part billed at the full rate`, () => {
    const parsed = parser.parseResponse(response, { endpoint: '/model/anthropic.claude-3/converse' });

    assert.equal(parsed.input_tokens, 10000 - cached, `${name} did not subtract its cached tokens`);
    assert.equal(parsed.cache_read_tokens ?? 0, cached);
    assert.equal(
      parsed.input_tokens + (parsed.cache_read_tokens ?? 0), 10000,
      `${name} lost or invented tokens while normalising`
    );
  });
}
