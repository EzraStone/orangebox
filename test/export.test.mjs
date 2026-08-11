import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareRuns, sanitizeExport, buildHtmlReport, buildOtelExport } from '../src/export.mjs';
import { evaluateRunAssertions } from '../src/assertions.mjs';

const payload = {
  orangebox_export: 1,
  orangebox_version: '1.0.0',
  exported_at: 1_700_000_000_000,
  run: {
    id: 'run-secret-id',
    name: 'Checkout test',
    cost_usd: 0.001,
    unknown_cost_count: 0
  },
  calls: [{
    id: 'call-secret-id',
    run_id: 'run-secret-id',
    seq: 1,
    provider: 'openai',
    endpoint: '/v1/responses',
    model: 'gpt-4.1-mini',
    started_at: 1_700_000_000_000,
    ended_at: 1_700_000_000_250,
    latency_ms: 250,
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: 0.001,
    request_json: JSON.stringify({
      instructions: 'Internal system prompt',
      input: [{ role: 'user', content: 'email me at dev@example.com' }],
      api_key: 'sk-test_abcdefghijklmnopqrstuvwxyz'
    }),
    response_json: JSON.stringify({ output_text: '</pre><script>alert(1)</script>' })
  }],
  tools: [{
    id: 'tool-event',
    run_id: 'run-secret-id',
    call_id: 'call-secret-id',
    kind: 'tool_use',
    tool_name: 'lookup_customer',
    tool_use_id: 'tool-call-secret',
    is_error: 0,
    content_json: JSON.stringify({ customer: 'dev@example.com' })
  }]
};

test('whole-run comparison aligns calls and calculates changes', () => {
  const runs = new Map([
    ['before', { id: 'before', name: 'Before' }],
    ['after', { id: 'after', name: 'After' }]
  ]);
  const calls = new Map([
    ['before', [{ seq: 1, model: 'gpt-a', latency_ms: 500, input_tokens: 20, output_tokens: 10, cost_usd: 0.01, error_type: null }]],
    ['after', [
      { seq: 1, model: 'gpt-b', latency_ms: 300, input_tokens: 18, output_tokens: 11, cost_usd: 0.008, error_type: null },
      { seq: 2, model: 'gpt-b', latency_ms: 100, input_tokens: 3, output_tokens: 2, cost_usd: 0.001, error_type: null }
    ]]
  ]);
  const store = {
    getRun: (id) => runs.get(id),
    callSummaries: (id) => calls.get(id),
    fullCalls: (id) => calls.get(id).map((call) => ({ ...call, id: `${id}-${call.seq}`, request_json: '{}', response_json: '{}' })),
    toolEvents: () => []
  };
  const result = compareRuns(store, 'before', 'after');
  assert.equal(result.pairs.length, 2);
  assert.equal(result.pairs[0].delta.latency_ms, -200);
  assert.equal(result.pairs[0].delta.model_changed, true);
  assert.equal(result.pairs[1].left, null);
  assert.equal(compareRuns(store, 'missing', 'after'), null);
});

test('sanitized exports redact prompts, tools, emails, secrets, and optionally IDs', () => {
  const basic = sanitizeExport(payload);
  const request = JSON.parse(basic.calls[0].request_json);
  assert.equal(request.instructions, '[redacted-system-prompt]');
  assert.equal(request.input[0].content, 'email me at [redacted-email]');
  assert.equal(request.api_key, '[redacted-secret]');
  assert.equal(basic.tools[0].content_json, '"[redacted-tool-content]"');

  const full = sanitizeExport(payload, { full: true });
  assert.notEqual(full.run.id, payload.run.id);
  assert.equal(full.calls[0].run_id, full.run.id);
  assert.notEqual(full.calls[0].id, payload.calls[0].id);
});

test('HTML reports are self-contained and recorded markup stays inert', () => {
  const html = buildHtmlReport(sanitizeExport(payload));
  assert.match(html, /^<!doctype html>/);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.equal(html.includes('dev@example.com'), false);
});

test('OpenTelemetry export uses GenAI attributes and tool events', () => {
  const otel = buildOtelExport(payload);
  const span = otel.resourceSpans[0].scopeSpans[0].spans[0];
  const attributes = Object.fromEntries(span.attributes.map(({ key, value }) => [key, value]));
  assert.equal(attributes['gen_ai.operation.name'].stringValue, 'responses');
  assert.equal(attributes['gen_ai.provider.name'].stringValue, 'openai');
  assert.equal(attributes['gen_ai.usage.input_tokens'].intValue, '10');
  assert.equal(span.events[0].name, 'gen_ai.tool_use');
  assert.match(span.traceId, /^[a-f0-9]{32}$/);
});

test('CI assertions report every breached threshold', () => {
  const run = { cost_usd: 0.2, error_count: 2, call_count: 4, unknown_cost_count: 1 };
  const calls = [{ latency_ms: 1200 }, { latency_ms: 50 }];
  const result = evaluateRunAssertions(run, calls, {
    maxCost: 0.1,
    maxLatency: 1000,
    maxErrors: 0,
    maxCalls: 3,
    requireKnownCost: true
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 5);
  assert.equal(evaluateRunAssertions(run, calls, { maxErrors: 2, maxCalls: 4 }).ok, true);
});
