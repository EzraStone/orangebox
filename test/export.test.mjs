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

const attributesOf = (span) => Object.fromEntries(span.attributes.map(({ key, value }) => [key, value]));

test('OpenTelemetry export uses GenAI attributes and tool events', () => {
  const otel = buildOtelExport(payload);
  const spans = otel.resourceSpans[0].scopeSpans[0].spans;
  const span = spans.find((s) => s.parentSpanId);
  const attributes = attributesOf(span);
  assert.equal(attributes['gen_ai.operation.name'].stringValue, 'chat');
  assert.equal(attributes['gen_ai.provider.name'].stringValue, 'openai');
  assert.equal(attributes['gen_ai.usage.input_tokens'].intValue, '10');
  assert.equal(attributes['openai.api.type'].stringValue, 'responses');
  assert.equal(span.events[0].name, 'gen_ai.tool_use');
  assert.match(span.traceId, /^[a-f0-9]{32}$/);
});

test('every call span hangs off one span for the run', () => {
  // Without a parent the export is a handful of unrelated root spans, and the
  // agent loop — the shape you exported the run to look at — is the one thing
  // the trace does not show.
  const spans = buildOtelExport(payload).resourceSpans[0].scopeSpans[0].spans;
  const roots = spans.filter((s) => !s.parentSpanId);

  assert.equal(roots.length, 1, 'exactly one span should have no parent');
  assert.ok(spans.length > 1, 'the run span should not be the only one');
  for (const span of spans.filter((s) => s.parentSpanId)) {
    assert.equal(span.parentSpanId, roots[0].spanId);
    assert.equal(span.traceId, roots[0].traceId);
  }
});

test('the run span carries what only the whole run knows', () => {
  const spans = buildOtelExport(payload).resourceSpans[0].scopeSpans[0].spans;
  const attributes = attributesOf(spans.find((s) => !s.parentSpanId));

  assert.ok(attributes['orangebox.run.id']);
  // The cost is a local price table applied to reported usage, never a figure
  // from the provider's billing, and the export has to say so.
  assert.equal(attributes['orangebox.run.cost_estimated'].boolValue, true);
  assert.ok('orangebox.context.growth' in attributes || 'orangebox.context.peak_tokens' in attributes);
  assert.ok('orangebox.loops.repeated_prompts' in attributes);
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

test('the HTML report answers the obvious questions above the calls', () => {
  // A bug report is read by somebody who was not there. Making them add up
  // fifteen per-call costs to learn what the run cost is how a report gets
  // skimmed once and never opened again.
  const html = buildHtmlReport(sanitizeExport(payload));
  assert.match(html, /<dl class="summary">/);
  assert.match(html, /Estimated cost/);
  assert.match(html, /Input tokens/);
  assert.match(html, /Largest prompt/);
});

test('a report of a looping run says so at the top', () => {
  const ask = JSON.stringify({ messages: [{ role: 'user', content: 'check the deploy' }] });
  const looping = {
    orangebox_export: 1,
    orangebox_version: '0.0.0',
    exported_at: Date.now(),
    run: { id: 'r', name: 'stuck', cost_usd: 0.12, unknown_cost_count: 0 },
    calls: [1, 2, 3, 4].map((seq) => ({
      seq, id: `c${seq}`, provider: 'anthropic', endpoint: '/v1/messages',
      cost_usd: 0.03, request_json: ask, input_tokens: 100
    })),
    tools: []
  };

  const html = buildHtmlReport(looping);
  assert.match(html, /4 calls asked the same thing/);
});

test('a report of a healthy run carries no warning strip', () => {
  const html = buildHtmlReport(sanitizeExport(payload));
  assert.equal(html.includes('class="flag"'), false);
});

test('report markup is still inert once the summary is in it', () => {
  // The summary interpolates recorded values too; every one of them has to go
  // through the same escaping as the call bodies.
  const nasty = structuredClone(payload);
  nasty.run.name = '<script>alert(1)</script>';
  const html = buildHtmlReport(sanitizeExport(nasty));
  assert.equal(html.includes('<script>alert(1)</script>'), false);
});

test('sanitizing a run keeps its token counts', () => {
  // "token" in the denylist means an auth token. It was also matching
  // input_tokens, output_tokens, cache_read_tokens and max_tokens, so every
  // sanitized export came out with no usage data and no idea what the request
  // had asked for — the two things a shared run is shared to show.
  const raw = {
    orangebox_export: 1,
    orangebox_version: '0.0.0',
    exported_at: Date.now(),
    run: { id: 'r', cost_usd: 0.01, unknown_cost_count: 0 },
    calls: [{
      seq: 1, id: 'c1', provider: 'anthropic', endpoint: '/v1/messages',
      input_tokens: 812, output_tokens: 93, cache_read_tokens: 40,
      request_json: JSON.stringify({ max_tokens: 1024, api_key: 'sk-live-abcdefghijklmnop' }),
      response_json: JSON.stringify({ usage: { input_tokens: 812, output_tokens: 93 } })
    }],
    tools: []
  };

  const clean = sanitizeExport(raw);
  const call = clean.calls[0];

  assert.equal(call.input_tokens, 812);
  assert.equal(call.output_tokens, 93);
  assert.equal(call.cache_read_tokens, 40);
  assert.match(call.request_json, /"max_tokens":1024/);
  assert.match(call.response_json, /"input_tokens":812/);

  // The actual credential is still gone.
  assert.equal(call.request_json.includes('sk-live-abcdefghijklmnop'), false);
  assert.match(call.request_json, /"api_key":"\[redacted-secret\]"/);
});

test('a string under a credential key is still redacted whatever it looks like', () => {
  const raw = {
    run: { id: 'r' },
    calls: [{
      seq: 1, id: 'c1',
      request_json: JSON.stringify({ auth_token: '12345', session_cookie: 'abc', secrets: ['a', 'b'] })
    }],
    tools: []
  };
  const request = sanitizeExport(raw).calls[0].request_json;

  assert.equal(request.includes('12345'), false, 'a numeric-looking string is still a string');
  assert.equal(request.includes('abc'), false);
  assert.equal(request.includes('"a"'), false, 'a list under a credential key goes wholesale');
});

test('a cut-off call says so in its span and in the report (§29)', () => {
  const cut = {
    orangebox_export: 1, orangebox_version: '0.0.0', exported_at: Date.now(),
    run: { id: 'r', name: 'cut', cost_usd: 0.02, unknown_cost_count: 0, error_count: 0 },
    calls: [
      { seq: 1, id: 'c1', provider: 'openai', endpoint: '/v1/chat/completions', model: 'gpt-5.6-sol', stop_reason: 'stop', started_at: 1, request_json: '{}' },
      { seq: 2, id: 'c2', provider: 'openai', endpoint: '/v1/chat/completions', model: 'gpt-5.6-sol', stop_reason: 'length', started_at: 2, request_json: '{}' }
    ],
    tools: []
  };

  const spans = buildOtelExport(cut).resourceSpans[0].scopeSpans[0].spans;
  const run = attributesOf(spans.find((s) => !s.parentSpanId));
  assert.equal(run['orangebox.truncated.calls'].intValue, '1');

  const second = attributesOf(spans.find((s) => s.name && s.parentSpanId && s.spanId && s.startTimeUnixNano === '2000000'));
  assert.equal(second['orangebox.truncated'].boolValue, true);
  // finish_reasons is a list in the GenAI conventions, and OTLP JSON wraps lists.
  assert.deepEqual(second['gen_ai.response.finish_reasons'], { arrayValue: { values: [{ stringValue: 'length' }] } });

  assert.match(buildHtmlReport(cut), /1 response was cut off at the output limit \(call 2\)/);
});

test('the Markdown report leads with the same summary as the HTML one', async () => {
  // One set of figures, two renderings — two reports of one run that
  // disagreed about its cost would be worse than either alone.
  const { buildMarkdownReport, runSummary } = await import('../src/export.mjs');
  const clean = sanitizeExport(payload);
  const md = buildMarkdownReport(clean);

  for (const [label, value] of runSummary(clean.run, clean.calls).items) {
    assert.ok(md.includes(`| ${label} | ${value}`), `${label} missing or different`);
  }
  assert.match(md, /^### orangebox run: /);
  assert.match(md, /\| # \| Model \| Latency \| Tokens \| Cost \| Stop \|/);
});

test('recorded values cannot break the Markdown table or close the fence', async () => {
  // A model name with a pipe would shift every column after it; a response
  // containing ``` would end the code block and render the rest as Markdown.
  const { buildMarkdownReport } = await import('../src/export.mjs');
  const nasty = {
    orangebox_export: 1, orangebox_version: '0.0.0', exported_at: Date.now(),
    run: { id: 'r', name: 'a | b\nc', cost_usd: 0.01, unknown_cost_count: 0 },
    calls: [{
      seq: 1, id: 'c1', provider: 'openai', endpoint: '/v1', model: 'evil|model<script>',
      stop_reason: 'stop', request_json: '{}', response_json: JSON.stringify({ text: 'x ``` y ```` z' })
    }],
    tools: []
  };
  const md = buildMarkdownReport(nasty);

  // Built with a variable rather than escapes in a literal: what is being
  // checked is that a backslash reaches the output, so the test should not
  // depend on one surviving its own quoting.
  const escapedPipe = String.fromCharCode(92) + '|';
  assert.ok(md.includes(`evil${escapedPipe}model&lt;script>`), 'pipe escaped and tag defused');
  assert.ok(md.includes(`a ${escapedPipe} b c`), 'newline in a name folded into the cell');
  assert.equal(md.includes('<script>'), false);

  // The response holds a run of four backticks, so its fence needs five; the
  // request holds none and keeps the ordinary three.
  const response = md.slice(md.indexOf('Last response'));
  const fence = response.match(/^(`{3,})json$/m)[1];
  assert.equal(fence.length, 5, 'the fence is longer than any run of backticks inside it');
  assert.ok(response.includes(`${fence}json`) && response.lastIndexOf(fence) > response.indexOf(`${fence}json`));
});
