// §07 — normalization: request/response mapping, tool extraction, and stream
// reassembly against recorded SSE transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as anthropic from '../src/parse/anthropic.mjs';
import * as openai from '../src/parse/openai.mjs';
import * as ollama from '../src/parse/ollama.mjs';
import { parseSseFrames } from '../src/parse/sse.mjs';
import { loadPricing } from '../src/pricing.mjs';
import { removeTempDir } from './helpers.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

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

test('anthropic: a streamed tool-use turn reassembles into the non-streamed shape (§7.2.1)', () => {
  const { response, error } = anthropic.reassembleStream(fixture('anthropic-stream-tool-use.sse'));
  assert.equal(error, null);

  assert.equal(response.id, 'msg_01StreamTool');
  assert.equal(response.model, 'claude-opus-5');
  assert.equal(response.role, 'assistant');
  assert.equal(response.stop_reason, 'tool_use');

  assert.equal(response.content.length, 2);
  assert.deepEqual(response.content[0], { type: 'text', text: 'Let me check the weather.' });
  assert.deepEqual(response.content[1], {
    type: 'tool_use',
    id: 'toolu_01Weather',
    name: 'get_weather',
    input: { city: 'Paris' }
  });

  // message_delta merges over message_start's seed usage.
  assert.equal(response.usage.input_tokens, 143);
  assert.equal(response.usage.output_tokens, 57);
  assert.equal(response.usage.cache_read_input_tokens, 2048);

  // The reassembled object feeds parseResponse exactly like a non-streamed one.
  const parsed = anthropic.parseResponse(response);
  assert.equal(parsed.output_tokens, 57);
  assert.equal(parsed.cache_read_tokens, 2048);
  assert.equal(parsed.stop_reason, 'tool_use');

  const uses = anthropic.extractToolUses(response);
  assert.equal(uses.length, 1);
  assert.deepEqual(uses[0].content, { city: 'Paris' });
});

test('anthropic: a stream that dies keeps what arrived and surfaces the error (§14.1)', () => {
  const { response, error } = anthropic.reassembleStream(fixture('anthropic-stream-error.sse'));
  assert.equal(error.type, 'overloaded_error');
  assert.equal(response.content[0].text, 'Halfway through this sen');
  assert.equal(response.stop_reason, null);
});

test('anthropic: tool arguments that never finish keep their raw fragment (§7.2.1.5)', () => {
  const truncated = [
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_x","name":"f","input":{}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    ''
  ].join('\n');

  const { response } = anthropic.reassembleStream(truncated);
  assert.equal(response.content[0].input_raw, '{"a":');
  assert.deepEqual(response.content[0].input, {});
});

test('anthropic: an empty transcript yields no response rather than a crash', () => {
  assert.deepEqual(anthropic.reassembleStream(''), { response: null, error: null });
  assert.deepEqual(anthropic.reassembleStream('data: not json\n\n'), { response: null, error: null });
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

test('openai: streamed tool_calls are stitched together by index (§7.3)', () => {
  const { response } = openai.reassembleStream(fixture('openai-stream-tool-use.sse'));

  assert.equal(response.id, 'chatcmpl-streamtool');
  assert.equal(response.object, 'chat.completion');
  assert.equal(response.model, 'gpt-4o-mini-2024-07-18');

  const choice = response.choices[0];
  assert.equal(choice.message.content, 'Checking now.');
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.deepEqual(choice.message.tool_calls, [
    {
      id: 'call_weather',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city": "Paris"}' }
    }
  ]);

  // Usage rides the terminal chunk when include_usage was requested.
  const parsed = openai.parseResponse(response);
  assert.equal(parsed.input_tokens, 88);
  assert.equal(parsed.output_tokens, 31);
  assert.equal(parsed.stop_reason, 'tool_calls');

  const uses = openai.extractToolUses(response);
  assert.deepEqual(uses[0].content, { city: 'Paris' });
});

test('openai: without include_usage the token fields stay null, not zero (§7.3)', () => {
  const { response } = openai.reassembleStream(fixture('openai-stream-no-usage.sse'));
  assert.equal(response.choices[0].message.content, 'ping');
  assert.equal(response.choices[0].finish_reason, 'stop');
  assert.equal(response.usage, undefined);

  const parsed = openai.parseResponse(response);
  assert.equal(parsed.input_tokens, null);
  assert.equal(parsed.output_tokens, null);
});

test('openai: reassembly stops at [DONE] and tolerates junk frames', () => {
  const { response } = openai.reassembleStream(
    'data: {"id":"x","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n' +
      'data: [DONE]\n\n' +
      'data: {"id":"x","model":"gpt-4o","choices":[{"index":0,"delta":{"content":" ignored"}}]}\n\n'
  );
  assert.equal(response.choices[0].message.content, 'hi');
  assert.deepEqual(openai.reassembleStream(''), { response: null, error: null });
});

test('openai responses: usage, function calls, and function outputs normalize', () => {
  const response = {
    id: 'resp_1',
    object: 'response',
    model: 'gpt-5.6-terra',
    status: 'completed',
    output: [
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_weather',
        name: 'get_weather',
        arguments: '{"city":"Paris"}'
      }
    ],
    usage: {
      input_tokens: 120,
      output_tokens: 35,
      input_tokens_details: { cached_tokens: 80 }
    }
  };
  assert.deepEqual(openai.parseResponse(response), {
    model: 'gpt-5.6-terra',
    stop_reason: 'completed',
    input_tokens: 120,
    output_tokens: 35,
    cache_read_tokens: 80,
    cache_write_tokens: null
  });
  assert.deepEqual(openai.extractToolUses(response)[0], {
    tool_name: 'get_weather',
    tool_use_id: 'call_weather',
    is_error: 0,
    content: { city: 'Paris' }
  });
  assert.deepEqual(openai.extractToolResults({
    input: [{ type: 'function_call_output', call_id: 'call_weather', output: '18C' }]
  })[0], {
    tool_name: null,
    tool_use_id: 'call_weather',
    is_error: 0,
    content: '18C'
  });
});

test('openai responses: semantic SSE events reassemble into a canonical response', () => {
  const event = (payload) => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
  const transcript = [
    { type: 'response.created', response: { id: 'resp_stream', object: 'response', model: 'gpt-5.6-terra', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'Hello' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] } },
    { type: 'response.completed', response: { id: 'resp_stream', object: 'response', model: 'gpt-5.6-terra', status: 'completed', output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2 } } }
  ].map(event).join('');

  const { response, error } = openai.reassembleStream(transcript);
  assert.equal(error, null);
  assert.equal(response.id, 'resp_stream');
  assert.equal(response.output[0].content[0].text, 'Hello');
  assert.equal(openai.parseResponse(response).output_tokens, 2);
});

test('openai responses: interrupted semantic streams retain partial text', () => {
  const transcript =
    'data: {"type":"response.created","response":{"id":"resp_partial","model":"gpt-5.6-terra","status":"in_progress","output":[]}}\n\n' +
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n' +
    'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"partial"}\n\n';
  const { response } = openai.reassembleStream(transcript);
  assert.equal(response.status, 'in_progress');
  assert.equal(response.output[0].content[0].text, 'partial');
});


// ================================================================= ollama

test('ollama: stream defaults to on, which is the opposite of the hosted APIs', () => {
  // Getting this backwards would mark every real stream as non-streamed and
  // silently discard TTFT for the whole provider.
  assert.equal(ollama.parseRequest({ model: 'llama3.2' }).stream, true);
  assert.equal(ollama.parseRequest({ model: 'llama3.2', stream: false }).stream, false);
  assert.equal(ollama.parseRequest({ model: 'llama3.2', stream: true }).stream, true);
  assert.equal(ollama.parseRequest(null).stream, false, 'junk stays conservative');
});

test('ollama: an NDJSON transcript folds into the non-streamed shape (§19.3)', () => {
  const { response, error } = ollama.reassembleStream(fixture('ollama-stream-tool-use.ndjson'));
  assert.equal(error, null);
  assert.equal(response.model, 'llama3.2');
  assert.equal(response.message.content, 'Let me check the weather.');
  assert.equal(response.done_reason, 'stop');

  const parsed = ollama.parseResponse(response);
  assert.equal(parsed.input_tokens, 143);
  assert.equal(parsed.output_tokens, 57);
  assert.equal(parsed.stop_reason, 'stop');
  assert.equal(parsed.cache_read_tokens, null, 'local inference has no prompt cache');
});

test('ollama: tool arguments are already objects, not JSON strings (§7.4)', () => {
  const { response } = ollama.reassembleStream(fixture('ollama-stream-tool-use.ndjson'));
  const uses = ollama.extractToolUses(response);
  assert.equal(uses.length, 1);
  assert.equal(uses[0].tool_name, 'get_weather');
  assert.deepEqual(uses[0].content, { city: 'Paris' });
  // No id is issued, so pairing falls back to name and position.
  assert.equal(uses[0].tool_use_id, 'get_weather#0');
});

test('ollama: a stream that dies keeps what arrived and surfaces the error', () => {
  const { response, error } = ollama.reassembleStream(fixture('ollama-stream-error.ndjson'));
  assert.equal(error.message, 'model runner has unexpectedly stopped');
  assert.equal(response.message.content, 'Halfway through this sen');
  assert.equal(response.done_reason, undefined);
});

test('ollama: partial trailing lines and junk degrade quietly (§07)', () => {
  // An aborted stream leaves half a line behind; it must not take the record
  // down with it.
  // Built by joining, so no escape sequence can be mangled on its way into
  // this file — which is exactly how it broke the first time.
  const partial = [
    '{"model":"llama3.2","message":{"role":"assistant","content":"hi"},"done":false}',
    '{"model":"llama3.2","message":{"role":"assis'
  ].join(String.fromCharCode(10));
  const { response } = ollama.reassembleStream(partial);
  assert.equal(response.message.content, 'hi');

  assert.deepEqual(ollama.reassembleStream(''), { response: null, error: null });
  for (const junk of [null, undefined, 42, [], { nope: true }]) {
    assert.equal(ollama.parseResponse(junk).model, null);
    assert.deepEqual(ollama.extractToolUses(junk), []);
    assert.deepEqual(ollama.extractToolResults(junk), []);
  }
});

test('ollama: role:tool messages become tool_result events (§7.4)', () => {
  const results = ollama.extractToolResults({
    messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather' } }] },
      { role: 'tool', tool_name: 'get_weather', content: '18C and clear' }
    ]
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_name, 'get_weather');
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

test('a user pricing file deep-merges over the shipped one (§08)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-pricing-'));
  const userFile = path.join(dir, 'pricing.json');

  fs.writeFileSync(
    userFile,
    JSON.stringify({
      // Correct one rate on an existing model; the others must survive.
      'claude-opus-5': { in: 9.99 },
      // And teach it a model it has never heard of.
      'llama-4-local': { in: 0, out: 0 }
    })
  );

  try {
    const pricing = loadPricing({ userFile });
    const opus = pricing.rateFor('claude-opus-5');
    assert.equal(opus.in, 9.99, 'override applied');
    assert.equal(opus.out, 25.0, 'untouched keys survive the merge');
    assert.equal(opus.cache_read, 0.5);

    assert.equal(pricing.rateFor('llama-4-local-q4').in, 0, 'new entries are matched by prefix too');
    assert.equal(pricing.rateFor('gpt-4o-mini').in, 0.15, 'unrelated models unaffected');
  } finally {
    await removeTempDir(dir);
  }
});

test('a malformed user pricing file is ignored rather than fatal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-pricing-'));
  const userFile = path.join(dir, 'pricing.json');
  fs.writeFileSync(userFile, '{ this is not json');
  try {
    const pricing = loadPricing({ userFile });
    assert.equal(pricing.rateFor('claude-opus-5').in, 5.0, 'falls back to the shipped table');
  } finally {
    await removeTempDir(dir);
  }
});

test('local providers cost nothing, which is not the same as unknown (§08, §19.3)', () => {
  const pricing = loadPricing({ userFile: '/nonexistent/pricing.json' });

  // Zero, not null: orangebox does know the answer for local inference, and an
  // em-dash would wrongly claim it does not.
  assert.equal(pricing.costFor({ provider: 'ollama', model: 'llama3.2', input_tokens: 1e6, output_tokens: 1e6 }), 0);
  assert.equal(pricing.costFor({ provider: 'ollama', model: 'anything-at-all' }), 0);

  // A hosted provider with the same unknown model still reports unknown.
  assert.equal(pricing.costFor({ provider: 'openai', model: 'anything-at-all', input_tokens: 100 }), null);
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
