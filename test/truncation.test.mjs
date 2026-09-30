// §29 — responses the model did not finish.
import test from 'node:test';
import assert from 'node:assert/strict';

import { TRUNCATION_REASONS, isTruncated, findTruncations } from '../src/truncation.mjs';
import { ROUTABLE_PROVIDERS } from '../src/server.mjs';
import * as anthropic from '../src/parse/anthropic.mjs';
import * as openai from '../src/parse/openai.mjs';
import * as gemini from '../src/parse/gemini.mjs';
import * as ollama from '../src/parse/ollama.mjs';
import * as bedrock from '../src/parse/bedrock.mjs';

test('every routable provider has said how it spells "ran out of room"', () => {
  // A provider missing from the table records its truncations as ordinary
  // stops. Nothing complains; the banner simply never appears for it.
  assert.deepEqual(Object.keys(TRUNCATION_REASONS).sort(), [...ROUTABLE_PROVIDERS].sort());
});

/** A response from each provider that hit its output limit, in its own shape. */
const CUT_OFF = {
  anthropic: [anthropic, { model: 'claude-opus-5', stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 1024 } }],
  openai: [openai, { object: 'chat.completion', model: 'gpt-5.6-sol', choices: [{ finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 1024 } }],
  gemini: [gemini, { modelVersion: 'gemini-2.5-pro', candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1024 } }],
  ollama: [ollama, { model: 'llama3.2', done: true, done_reason: 'length', prompt_eval_count: 10, eval_count: 1024 }],
  bedrock: [bedrock, { stopReason: 'max_tokens', usage: { inputTokens: 10, outputTokens: 1024 } }]
};

for (const [provider, [parser, response]] of Object.entries(CUT_OFF)) {
  test(`${provider}: a response cut off at its limit is recognised as one`, () => {
    // Through the real parser, so the table is checked against what is actually
    // stored rather than against what somebody believed the provider sends.
    const parsed = parser.parseResponse(response, { endpoint: '/model/anthropic.claude-3/converse' });
    assert.ok(isTruncated(parsed.stop_reason, provider), `${provider} stored "${parsed.stop_reason}"`);
  });
}

test('the OpenAI Responses API is covered as well as Chat Completions', () => {
  const parsed = openai.parseResponse({
    object: 'response', model: 'gpt-5.6-sol', status: 'incomplete', output: [],
    incomplete_details: { reason: 'max_output_tokens' }
  });
  assert.ok(isTruncated(parsed.stop_reason, 'openai'));
});

test('an ordinary stop is not a truncation', () => {
  for (const [provider, reason] of [
    ['anthropic', 'end_turn'], ['anthropic', 'tool_use'], ['openai', 'stop'], ['openai', 'tool_calls'],
    ['gemini', 'STOP'], ['ollama', 'stop'], ['bedrock', 'end_turn']
  ]) {
    assert.equal(isTruncated(reason, provider), false, `${provider} ${reason}`);
  }
  assert.equal(isTruncated(null), false);
  assert.equal(isTruncated(''), false);
});

test('without a provider, any provider spelling still counts', () => {
  // An imported run from an old export may not say where a call went.
  assert.ok(isTruncated('length'));
  assert.ok(isTruncated('MAX_TOKENS'));
  assert.equal(isTruncated('end_turn'), false);
});

test('truncations are counted against the calls that answered', () => {
  // A call that errored has no stop reason, and counting it in the denominator
  // would make a run that failed loudly look like one that truncated rarely.
  const result = findTruncations([
    { id: 'a', seq: 1, provider: 'anthropic', stop_reason: 'end_turn' },
    { id: 'b', seq: 3, provider: 'anthropic', stop_reason: 'max_tokens', output_tokens: 4096, model: 'claude-opus-5' },
    { id: 'c', seq: 2, provider: 'openai', stop_reason: 'length', output_tokens: 256 },
    { id: 'd', seq: 4, provider: 'anthropic', stop_reason: null }
  ]);

  assert.equal(result.total_calls, 4);
  assert.equal(result.answered_calls, 3);
  assert.equal(result.truncated_calls, 2);
  assert.equal(result.share, 2 / 3);
  assert.deepEqual(result.calls.map((c) => c.seq), [2, 3], 'in run order');
  assert.equal(result.calls[1].output_tokens, 4096);
});

test('a run with nothing answered reports a share of zero, not NaN', () => {
  const result = findTruncations([{ id: 'a', seq: 1, provider: 'anthropic', stop_reason: null }]);
  assert.equal(result.share, 0);
  assert.equal(result.truncated_calls, 0);
});

test('truncationsIn reads a real run out of the store', async () => {
  const { Store, newId } = await import('../src/store.mjs');
  const store = new Store(':memory:');
  try {
    const run = store.createRun({ name: 'cut short', source: 'gap' });
    const add = (provider, stop) => store.insertCall({
      id: newId(), run_id: run.id, seq: store.nextSeq(run.id),
      provider, endpoint: '/v1/messages', model: 'm', started_at: Date.now(),
      output_tokens: 512, stop_reason: stop, request_json: '{}'
    });

    add('anthropic', 'end_turn');
    add('anthropic', 'max_tokens');
    add('openai', 'length');
    add('openai', 'stop');

    const result = store.truncationsIn(run.id);
    assert.equal(result.truncated_calls, 2);
    assert.equal(result.answered_calls, 4);
    assert.deepEqual(result.calls.map((c) => c.stop_reason), ['max_tokens', 'length']);
  } finally {
    store.close();
  }
});

test('GET /api/runs/:id/truncations answers with the same shape as the store', async () => {
  const { startOrangebox, removeTempDir } = await import('./helpers.mjs');
  const { newId } = await import('../src/store.mjs');
  const app = await startOrangebox({});

  try {
    const run = app.store.createRun({ name: 'cut short', source: 'gap' });
    for (const stop of ['end_turn', 'max_tokens', 'max_tokens']) {
      app.store.insertCall({
        id: newId(), run_id: run.id, seq: app.store.nextSeq(run.id),
        provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
        started_at: Date.now(), output_tokens: 1024, stop_reason: stop, request_json: '{}'
      });
    }

    const body = await (await fetch(`${app.origin}/api/runs/${run.id}/truncations`)).json();
    assert.deepEqual(body, app.store.truncationsIn(run.id));
    assert.equal(body.truncated_calls, 2);

    const missing = await fetch(`${app.origin}/api/runs/no-such-run/truncations`);
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
    removeTempDir(app.dbPath);
  }
});

test('the timeline recognises the same cut-off reasons as the server', async () => {
  // ui/dom.js cannot import src/truncation.mjs, so it keeps its own list. Before
  // this, the timeline knew only Anthropic's spelling: an OpenAI response cut
  // off with "length" drew as an ordinary finish, with no warning at all.
  const { TRUNCATED_STOPS, stopKind } = await import('../ui/dom.js');
  const server = new Set(Object.values(TRUNCATION_REASONS).flat());

  assert.deepEqual([...TRUNCATED_STOPS].sort(), [...server].sort());
  for (const reason of server) assert.equal(stopKind(reason), 'truncated', reason);
});

test('the timeline marks a tool stop whichever provider made it', async () => {
  const { stopKind } = await import('../ui/dom.js');
  assert.equal(stopKind('tool_use'), 'tool');
  assert.equal(stopKind('tool_calls'), 'tool', 'OpenAI spells it tool_calls');
  assert.equal(stopKind('end_turn'), '');
  assert.equal(stopKind(null), '');
});
