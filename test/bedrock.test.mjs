// §07 / §19.3 — Bedrock Converse and ConverseStream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame } from '../src/parse/eventstream.mjs';
import * as bedrock from '../src/parse/bedrock.mjs';

const event = (type, body, extra = {}) =>
  encodeFrame(
    { ':event-type': type, ':content-type': 'application/json', ':message-type': 'event', ...extra },
    Buffer.from(JSON.stringify(body), 'utf8')
  );

const SONNET = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

test('the model comes out of the url, colons and all', () => {
  // Bedrock ids contain dots and a colon, and arrive percent-encoded.
  const path = `/model/${encodeURIComponent(SONNET)}/converse`;
  assert.deepEqual(bedrock.splitEndpoint(path), { model: SONNET, streaming: false });

  const streamPath = `/model/${encodeURIComponent(SONNET)}/converse-stream`;
  assert.deepEqual(bedrock.splitEndpoint(streamPath), { model: SONNET, streaming: true });
});

test('an unrecognisable path degrades to nulls rather than throwing', () => {
  assert.deepEqual(bedrock.splitEndpoint('/nonsense'), { model: null, streaming: false });
  assert.deepEqual(bedrock.splitEndpoint(undefined), { model: null, streaming: false });
  // A broken percent-escape keeps the raw text instead of losing the record.
  assert.equal(bedrock.splitEndpoint('/model/bad%ZZid/converse').model, 'bad%ZZid');
});

test('parseRequest reads streaming from the path, not the body', () => {
  // Every other provider puts `stream` in the JSON. Bedrock puts it in the verb.
  const body = { messages: [{ role: 'user', content: [{ text: 'hi' }] }] };
  assert.deepEqual(bedrock.parseRequest(body, { endpoint: `/model/${SONNET}/converse` }), {
    model: SONNET,
    stream: false
  });
  assert.deepEqual(bedrock.parseRequest(body, { endpoint: `/model/${SONNET}/converse-stream` }), {
    model: SONNET,
    stream: true
  });
});

test('parseResponse maps AWS spelling onto our token columns', () => {
  const result = bedrock.parseResponse(
    {
      stopReason: 'end_turn',
      usage: { inputTokens: 1200, outputTokens: 88, cacheReadInputTokens: 900, cacheWriteInputTokens: 40 }
    },
    { endpoint: `/model/${SONNET}/converse` }
  );
  assert.equal(result.model, SONNET);
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.input_tokens, 1200);
  assert.equal(result.output_tokens, 88);
  assert.equal(result.cache_read_tokens, 900);
  assert.equal(result.cache_write_tokens, 40);
});

test('a garbage response body gives nulls, never a throw', () => {
  for (const bad of [null, undefined, 'text', 42, []]) {
    const out = bedrock.parseResponse(bad, { endpoint: '/model/x/converse' });
    assert.equal(out.input_tokens, null);
    assert.equal(out.stop_reason, null);
  }
});

test('a streamed conversation folds back into a converse response (§7.2.1)', () => {
  const captured = Buffer.concat([
    event('messageStart', { role: 'assistant' }),
    event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'The answer ' } }),
    event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'is 42.' } }),
    event('contentBlockStop', { contentBlockIndex: 0 }),
    event('messageStop', { stopReason: 'end_turn' }),
    event('metadata', {
      usage: { inputTokens: 310, outputTokens: 12, cacheReadInputTokens: 0 },
      metrics: { latencyMs: 640 }
    })
  ]);

  const { response, error } = bedrock.reassembleStream(captured);
  assert.equal(error, null);
  assert.equal(response.output.message.role, 'assistant');
  assert.deepEqual(response.output.message.content, [{ type: 'text', text: 'The answer is 42.' }]);
  assert.equal(response.stopReason, 'end_turn');
  assert.equal(response.usage.inputTokens, 310);
  assert.equal(response.metrics.latencyMs, 640);
});

test('streamed tool arguments are reassembled from their json fragments', () => {
  const captured = Buffer.concat([
    event('messageStart', { role: 'assistant' }),
    event('contentBlockStart', {
      contentBlockIndex: 0,
      start: { toolUse: { toolUseId: 'tooluse_abc', name: 'get_weather' } }
    }),
    event('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '{"city":' } } }),
    event('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '"Oslo"}' } } }),
    event('contentBlockStop', { contentBlockIndex: 0 }),
    event('messageStop', { stopReason: 'tool_use' })
  ]);

  const { response } = bedrock.reassembleStream(captured);
  const block = response.output.message.content[0];
  assert.equal(block.type, 'tool_use');
  assert.equal(block.name, 'get_weather');
  assert.deepEqual(block.input, { city: 'Oslo' });

  const uses = bedrock.extractToolUses(response);
  assert.equal(uses.length, 1);
  assert.equal(uses[0].tool_name, 'get_weather');
  assert.equal(uses[0].tool_use_id, 'tooluse_abc');
  assert.deepEqual(uses[0].content, { city: 'Oslo' });
});

test('tool arguments cut off mid-json are kept as a fragment, not dropped', () => {
  // §7.2.1.5. A truncated call is the most interesting thing on the timeline;
  // throwing the arguments away is how you lose the reason the agent broke.
  const captured = Buffer.concat([
    event('contentBlockStart', {
      contentBlockIndex: 0,
      start: { toolUse: { toolUseId: 'tooluse_x', name: 'search' } }
    }),
    event('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '{"query":"unfin' } } }),
    event('contentBlockStop', { contentBlockIndex: 0 })
  ]);

  const block = bedrock.reassembleStream(captured).response.output.message.content[0];
  assert.deepEqual(block.input, {});
  assert.equal(block.input_raw, '{"query":"unfin');
});

test('a delta for a block that was never announced still lands', () => {
  // Bedrock frequently sends text deltas with no contentBlockStart in front.
  const captured = event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'orphan' } });
  const content = bedrock.reassembleStream(captured).response.output.message.content;
  assert.deepEqual(content, [{ type: 'text', text: 'orphan' }]);
});

test('reasoning deltas are kept apart from the answer text', () => {
  const captured = Buffer.concat([
    event('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { text: 'thinking...' } } }),
    event('contentBlockDelta', { contentBlockIndex: 1, delta: { text: 'answer' } })
  ]);
  const content = bedrock.reassembleStream(captured).response.output.message.content;
  assert.equal(content[0].thinking, 'thinking...');
  assert.equal(content[1].text, 'answer');
});

test('an exception frame is reported as an error, keeping its fault name', () => {
  const captured = Buffer.concat([
    event('messageStart', { role: 'assistant' }),
    encodeFrame(
      { ':message-type': 'exception', ':exception-type': 'throttlingException', ':content-type': 'application/json' },
      Buffer.from(JSON.stringify({ message: 'Too many requests' }), 'utf8')
    )
  ]);

  const { error } = bedrock.reassembleStream(captured);
  assert.equal(error.type, 'throttlingException');
  assert.equal(error.message, 'Too many requests');
});

test('first-token detection fires on content, not on the opening frame', () => {
  // §06.3 — ttft has to mean "the model started answering", so messageStart
  // must not count. It arrives immediately and would make every ttft ~0.
  assert.equal(bedrock.firstTokenSeen(event('messageStart', { role: 'assistant' })), false);
  assert.equal(
    bedrock.firstTokenSeen(
      Buffer.concat([
        event('messageStart', { role: 'assistant' }),
        event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'x' } })
      ])
    ),
    true
  );
  assert.equal(bedrock.firstTokenSeen(Buffer.alloc(0)), false);
});

test('toolResult blocks in the request history are extracted (§7.4)', () => {
  const request = {
    messages: [
      { role: 'user', content: [{ text: 'weather?' }] },
      { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'get_weather', input: {} } }] },
      {
        role: 'user',
        content: [
          { toolResult: { toolUseId: 't1', status: 'error', content: [{ text: 'timed out' }] } },
          { toolResult: { toolUseId: 't2', content: [{ text: 'ok' }] } }
        ]
      }
    ]
  };

  const results = bedrock.extractToolResults(request);
  assert.equal(results.length, 2);
  assert.equal(results[0].tool_use_id, 't1');
  assert.equal(results[0].is_error, 1);
  assert.equal(results[1].is_error, 0);
});

test('an empty stream reports nothing rather than an empty message', () => {
  const { response, error } = bedrock.reassembleStream(Buffer.alloc(0));
  assert.equal(response, null);
  assert.equal(error, null);
});
