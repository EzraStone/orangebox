// §07 — normalization. Stream reassembly against recorded fixtures lands in M2;
// this file covers request/response mapping and tool extraction.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as anthropic from '../src/parse/anthropic.mjs';
import * as openai from '../src/parse/openai.mjs';
import { parseSseFrames } from '../src/parse/sse.mjs';
import { loadPricing } from '../src/pricing.mjs';

test('SSE framing survives CRLF, comments, and multi-line data', () => {
  const frames = parseSseFrames(
    ': heartbeat\n\n' +
      'event: message_start\r\ndata: {"a":1}\r\n\r\n' +
      'data: line one\ndata: line two\n\n' +
      'event: ping\ndata: {}\n\n'
  );
  assert.equal(frames.length, 3);
  assert.deepEqual(frames[0], { event: 'message_start', data: '{"a":1}' });
  assert.equal(frames[1].data, 'line one\nline two');
  assert.equal(frames[2].event, 'ping');
});

// ============================================================== anthropic

test('anthropic: request and response map onto the normalized record (§7.2)', () => {
  assert.deepEqual(
    anthropic.parseRequest({ model: 'claude-opus-5', stream: true, messages: [] }),
    { model: 'claude-opus-5', stream: true }
  );

  const parsed = anthropic.parseResponse({
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    content: [],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50
    }
  });
  assert.deepEqual(parsed, {
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 900,
    cache_write_tokens: 50
  });
});

test('anthropic: unknown shapes degrade to nulls instead of throwing (§07)', () => {
  for (const junk of [null, undefined, 42, 'nope', [], { unexpected: true }]) {
    const out = anthropic.parseResponse(junk);
    assert.equal(out.model, null);
    assert.equal(out.input_tokens, null);
    assert.deepEqual(anthropic.extractToolUses(junk), []);
    assert.deepEqual(anthropic.extractToolResults(junk), []);
  }
});

test('anthropic: tool_use and tool_result extraction (§7.4)', () => {
  const uses = anthropic.extractToolUses({
    content: [
      { type: 'text', text: 'hold on' },
      { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { q: 'orangebox' } }
    ]
  });
  assert.deepEqual(uses, [
    { tool_name: 'web_search', tool_use_id: 'toolu_1', is_error: 0, content: { q: 'orangebox' } }
  ]);

  const results = anthropic.extractToolResults({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true }
        ]
      }
    ]
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_use_id, 'toolu_1');
  assert.equal(results[0].is_error, 1);
});

// ================================================================= openai

test('openai: request and response map onto the normalized record (§7.3)', () => {
  assert.deepEqual(
    openai.parseRequest({ model: 'gpt-4o-mini', stream: false }),
    { model: 'gpt-4o-mini', stream: false }
  );

  const parsed = openai.parseResponse({
    model: 'gpt-4o-mini-2024-07-18',
    choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 2 }
  });
  assert.equal(parsed.model, 'gpt-4o-mini-2024-07-18');
  assert.equal(parsed.stop_reason, 'stop');
  assert.equal(parsed.input_tokens, 11);
  assert.equal(parsed.output_tokens, 2);
  assert.equal(parsed.cache_read_tokens, null);
});

test('openai: tool_calls parse their JSON-string arguments, keeping the raw on failure', () => {
  const uses = openai.extractToolUses({
    choices: [
      {
        message: {
          tool_calls: [
            { id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
            { id: 'call_2', function: { name: 'broken', arguments: '{"city":' } }
          ]
        }
      }
    ]
  });
  assert.deepEqual(uses[0].content, { city: 'Paris' });
  assert.equal(uses[0].tool_use_id, 'call_1');
  assert.equal(uses[1].content._orangebox_unparsed_arguments, '{"city":');
});

test('openai: role:tool messages become tool_result events (§7.4)', () => {
  const results = openai.extractToolResults({
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', tool_calls: [{ id: 'call_1' }] },
      { role: 'tool', tool_call_id: 'call_1', content: '18C and clear' }
    ]
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_use_id, 'call_1');
  assert.equal(results[0].content, '18C and clear');
});

// ================================================================ pricing

test('pricing matches the longest key that prefixes the model (§08)', () => {
  const pricing = loadPricing({ userFile: '/nonexistent/pricing.json' });

  // A dated snapshot still resolves through its alias prefix.
  assert.equal(pricing.rateFor('claude-haiku-4-5-20251001').in, 1.0);
  // gpt-4o is a prefix of gpt-4o-mini; the longer key must win.
  assert.equal(pricing.rateFor('gpt-4o-mini').in, 0.15);
  assert.equal(pricing.rateFor('gpt-4o').in, 2.5);
  assert.equal(pricing.rateFor('gpt-5-nano-2026-01-01').out, 0.4);
  assert.equal(pricing.rateFor('some-local-llama'), null);
  assert.equal(pricing.rateFor(null), null);
});

test('cost is null for unpriced models and for calls with no token counts (§08)', () => {
  const pricing = loadPricing({ userFile: '/nonexistent/pricing.json' });

  assert.equal(pricing.costFor({ model: 'mystery-model', input_tokens: 100 }), null);
  assert.equal(
    pricing.costFor({
      model: 'claude-opus-5',
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null
    }),
    null,
    'no counts is not the same as zero cost'
  );

  // 1e6 in @ $5 + 1e6 out @ $25 = $30
  assert.equal(
    pricing.costFor({ model: 'claude-opus-5', input_tokens: 1e6, output_tokens: 1e6 }),
    30
  );
  // A partial count still produces an estimate; the missing field counts as 0.
  assert.equal(pricing.costFor({ model: 'claude-opus-5', input_tokens: 1e6 }), 5);
});
