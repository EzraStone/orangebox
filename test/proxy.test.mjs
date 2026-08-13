// §17.1 — integration tests against a mock upstream. No real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  startMockUpstream,
  startOrangebox,
  jsonResponse,
  sseResponse,
  sleep,
  getJson,
  settle,
  ANTHROPIC_MESSAGE,
  OPENAI_COMPLETION,
  removeTempDir
} from './helpers.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/**
 * Split a transcript into its wire frames, so the mock can dribble them out.
 * Tolerates CRLF: a checkout that rewrote the fixtures would otherwise yield a
 * single frame containing everything, which silently turns every streaming test
 * into a non-streaming one. `.gitattributes` should prevent that; this makes
 * sure a slip there fails loudly instead of quietly changing what is tested.
 */
const frames = (text) => text.split(/(?<=\r?\n\r?\n)/).filter(Boolean);

async function withRig(handler, run, { gapSeconds = 120 } = {}) {
  const upstream = await startMockUpstream(handler);
  const app = await startOrangebox({
    providers: { anthropic: upstream.origin, openai: upstream.origin },
    gapSeconds
  });
  try {
    await run({ app, upstream });
  } finally {
    await app.stop();
    await upstream.close();
  }
}

const anthropicRequest = {
  model: 'claude-haiku-4-5',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'say ping' }]
};

test('non-streamed Anthropic call is relayed byte-identically and recorded', async () => {
  await withRig(
    (req, res) => jsonResponse(res, 200, ANTHROPIC_MESSAGE),
    async ({ app, upstream }) => {
      const res = await fetch(`${app.origin}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-secret-value' },
        body: JSON.stringify(anthropicRequest)
      });

      // §17.1 check 2 — the client sees exactly what upstream sent.
      assert.equal(res.status, 200);
      assert.equal(await res.text(), JSON.stringify(ANTHROPIC_MESSAGE));

      // §06.1.3 — auth passes through, encoding is forced to identity.
      assert.equal(upstream.requests[0].headers['x-api-key'], 'sk-ant-secret-value');
      assert.equal(upstream.requests[0].headers['accept-encoding'], 'identity');
      assert.equal(upstream.requests[0].url, '/v1/messages');

      assert.ok(await settle(app, () => app.store.countRuns() === 1), 'run was created');
      const { runs } = app.store.listRuns();
      const calls = app.store.callSummaries(runs[0].id);
      assert.equal(calls.length, 1);

      const call = calls[0];
      assert.equal(call.provider, 'anthropic');
      assert.equal(call.endpoint, '/v1/messages');
      assert.equal(call.status, 200);
      assert.equal(call.error_type, null);
      assert.equal(call.streamed, 0);
      assert.equal(call.seq, 1);
      // §7.1 — the response's model wins over the request's alias.
      assert.equal(call.model, 'claude-haiku-4-5-20251001');
      assert.equal(call.stop_reason, 'end_turn');
      assert.equal(call.input_tokens, 12);
      assert.equal(call.output_tokens, 5);
      assert.equal(call.cache_read_tokens, 100);
      assert.equal(call.cache_write_tokens, 40);
      assert.ok(call.latency_ms >= 0);

      // §08 — 12/1e6*1 + 5/1e6*5 + 100/1e6*0.1 + 40/1e6*1.25
      assert.ok(Math.abs(call.cost_usd - 0.0000970) < 1e-9, `cost was ${call.cost_usd}`);

      // §06.4 — an unattributed call lands in a gap-created run.
      assert.equal(runs[0].source, 'gap');
      assert.equal(runs[0].call_count, 1);
      assert.equal(runs[0].input_tokens, 12);
      assert.equal(runs[0].output_tokens, 5);
      assert.equal(runs[0].error_count, 0);
    }
  );
});

test('API keys never reach the database (§17.1 check 4)', async () => {
  await withRig(
    (req, res) => jsonResponse(res, 200, ANTHROPIC_MESSAGE),
    async ({ app }) => {
      await fetch(`${app.origin}/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'sk-ant-DO-NOT-STORE-ME',
          authorization: 'Bearer sk-DO-NOT-STORE-ME',
          cookie: 'session=DO-NOT-STORE-ME'
        },
        body: JSON.stringify(anthropicRequest)
      });

      assert.ok(await settle(app, () => app.store.countRuns() === 1));
      const runId = app.store.listRuns().runs[0].id;
      const full = app.store.fullCalls(runId)[0];
      const everything = full.request_json + (full.response_json ?? '');
      assert.equal(everything.includes('DO-NOT-STORE-ME'), false);

      // The allowlist still keeps what is safe and useful (§12.2).
      const meta = JSON.parse(full.request_json)._orangebox;
      assert.equal(meta.headers['content-type'], 'application/json');
      assert.equal('x-api-key' in meta.headers, false);
      assert.equal('authorization' in meta.headers, false);
    }
  );
});

test('OpenAI usage fields map onto the normalized record (§7.3)', async () => {
  await withRig(
    (req, res) => jsonResponse(res, 200, OPENAI_COMPLETION),
    async ({ app }) => {
      const res = await fetch(`${app.origin}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'say ping' }]
        })
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), OPENAI_COMPLETION);

      assert.ok(await settle(app, () => app.store.countRuns() === 1));
      const call = app.store.callSummaries(app.store.listRuns().runs[0].id)[0];
      assert.equal(call.provider, 'openai');
      assert.equal(call.model, 'gpt-4o-mini-2024-07-18');
      assert.equal(call.input_tokens, 20);
      assert.equal(call.output_tokens, 3);
      assert.equal(call.stop_reason, 'stop');
      // 20/1e6*0.15 + 3/1e6*0.60
      assert.ok(Math.abs(call.cost_usd - 0.0000048) < 1e-12);
    }
  );
});

test('OpenAI Responses API records output items, usage, and function calls', async () => {
  const responseBody = {
    id: 'resp_test',
    object: 'response',
    model: 'gpt-4o-mini',
    status: 'completed',
    output: [{
      id: 'fc_1',
      type: 'function_call',
      call_id: 'call_weather',
      name: 'get_weather',
      arguments: '{"city":"Paris"}'
    }],
    usage: {
      input_tokens: 30,
      output_tokens: 8,
      input_tokens_details: { cached_tokens: 7 }
    }
  };
  await withRig(
    (req, res) => jsonResponse(res, 200, responseBody),
    async ({ app }) => {
      const res = await fetch(`${app.origin}/openai/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
        body: JSON.stringify({ model: 'gpt-4o-mini', input: 'weather in Paris?' })
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), responseBody);
      assert.ok(await settle(app, () => app.store.countRuns() === 1));
      const run = app.store.listRuns().runs[0];
      const call = app.store.callSummaries(run.id)[0];
      assert.equal(call.endpoint, '/v1/responses');
      assert.equal(call.input_tokens, 30);
      assert.equal(call.output_tokens, 8);
      assert.equal(call.cache_read_tokens, 7);
      assert.equal(call.stop_reason, 'completed');
      const tools = app.store.toolEvents(run.id);
      assert.equal(tools[0].tool_name, 'get_weather');
      assert.equal(tools[0].tool_use_id, 'call_weather');
    }
  );
});

test('upstream 429 is relayed verbatim and classified http_429 (§17.1 check 7)', async () => {
  const errorBody = { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } };
  await withRig(
    (req, res) => jsonResponse(res, 429, errorBody, { 'retry-after': '3' }),
    async ({ app }) => {
      const res = await fetch(`${app.origin}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(anthropicRequest)
      });
      assert.equal(res.status, 429);
      assert.equal(res.headers.get('retry-after'), '3');
      assert.deepEqual(await res.json(), errorBody);

      assert.ok(await settle(app, () => app.store.countRuns() === 1));
      const run = app.store.listRuns().runs[0];
      const call = app.store.callSummaries(run.id)[0];
      assert.equal(call.status, 429);
      assert.equal(call.error_type, 'http_429');
      assert.equal(run.error_count, 1);
    }
  );
});

test('unreachable upstream answers 502 and records the request (§14.1)', async () => {
  // Take a real loopback port, then let it go: connecting to it now refuses
  // immediately, which a reserved port like :1 does not reliably do on Windows.
  const dead = await startMockUpstream((req, res) => res.end());
  await dead.close();

  const app = await startOrangebox({
    providers: { anthropic: dead.origin, openai: dead.origin }
  });
  try {
    const res = await fetch(`${app.origin}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(anthropicRequest)
    });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'upstream_unreachable');

    assert.ok(await settle(app, () => app.store.countRuns() === 1));
    const call = app.store.callSummaries(app.store.listRuns().runs[0].id)[0];
    assert.equal(call.error_type, 'upstream_unreachable');
    assert.equal(call.status, null);
    assert.equal(call.response_json, undefined); // summaries omit blobs (§10)
  } finally {
    await app.stop();
  }
});

test('run attribution: path prefix, header, and idle gap (§06.4)', async () => {
  await withRig(
    (req, res) => jsonResponse(res, 200, ANTHROPIC_MESSAGE),
    async ({ app, upstream }) => {
      const send = (path, headers = {}) =>
        fetch(`${app.origin}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(anthropicRequest)
        });

      // 1. explicit, via POST /api/runs/begin + the run-scoped prefix
      const begun = await getJson(`${app.origin}/api/runs/begin`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-orangebox-csrf': (await getJson(`${app.origin}/api/health`)).body.csrf_token
        },
        body: JSON.stringify({ name: 'checkout bot' })
      });
      const explicitId = begun.body.id;
      await send(`/r/${explicitId}/anthropic/v1/messages`);

      // 2. header-attributed
      await send('/anthropic/v1/messages', { 'x-orangebox-run-id': 'my-own-run' });

      // 3. implicit — two calls inside the gap window share one run
      await send('/anthropic/v1/messages');
      await send('/anthropic/v1/messages');

      assert.ok(await settle(app, () => app.store.countRuns() === 3), 'three runs');

      const explicit = app.store.getRun(explicitId);
      assert.equal(explicit.source, 'explicit');
      assert.equal(explicit.name, 'checkout bot');
      assert.equal(explicit.call_count, 1);

      const header = app.store.getRun('my-own-run');
      assert.equal(header.source, 'header');
      assert.equal(header.call_count, 1);

      const gapRun = app.store.listRuns().runs.find((r) => r.source === 'gap');
      assert.equal(gapRun.call_count, 2);
      const seqs = app.store.callSummaries(gapRun.id).map((c) => c.seq);
      assert.deepEqual(seqs, [1, 2]);

      // The run header is ours; it must not leak upstream (§06.1.3).
      for (const seen of upstream.requests) {
        assert.equal('x-orangebox-run-id' in seen.headers, false);
      }
    }
  );
});

test('a zero-second gap starts a fresh run per call (§06.4)', async () => {
  await withRig(
    (req, res) => jsonResponse(res, 200, ANTHROPIC_MESSAGE),
    async ({ app }) => {
      for (let i = 0; i < 3; i++) {
        await fetch(`${app.origin}/anthropic/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(anthropicRequest)
        });
      }
      assert.ok(await settle(app, () => app.store.countRuns() === 3), 'three separate runs');
      for (const run of app.store.listRuns().runs) {
        assert.equal(run.source, 'gap');
        assert.match(run.name, /^run \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      }
    },
    { gapSeconds: 0 }
  );
});

test('tool_use and tool_result are paired across calls exactly once (§07.4)', async () => {
  const toolUseResponse = {
    ...ANTHROPIC_MESSAGE,
    content: [
      { type: 'text', text: 'let me look that up' },
      { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Paris' } }
    ],
    stop_reason: 'tool_use'
  };

  let turn = 0;
  await withRig(
    (req, res) => jsonResponse(res, 200, turn++ === 0 ? toolUseResponse : ANTHROPIC_MESSAGE),
    async ({ app }) => {
      const send = (body) =>
        fetch(`${app.origin}/r/run-tools/anthropic/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        });

      await send(anthropicRequest);

      const withResult = {
        ...anthropicRequest,
        messages: [
          ...anthropicRequest.messages,
          { role: 'assistant', content: toolUseResponse.content },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_01', content: '18C and clear', is_error: false }
            ]
          }
        ]
      };
      await send(withResult);

      // A third call re-sends the same history; the tool_result must not double up.
      await send({
        ...withResult,
        messages: [...withResult.messages, { role: 'user', content: 'thanks' }]
      });

      assert.ok(await settle(app, () => app.store.toolEvents('run-tools').length >= 2));
      const events = app.store.toolEvents('run-tools');
      assert.equal(events.length, 2, `expected exactly 2 tool events, got ${events.length}`);

      const use = events.find((e) => e.kind === 'tool_use');
      assert.equal(use.tool_name, 'get_weather');
      assert.equal(use.tool_use_id, 'toolu_01');
      assert.deepEqual(JSON.parse(use.content_json), { city: 'Paris' });

      const result = events.find((e) => e.kind === 'tool_result');
      assert.equal(result.tool_use_id, 'toolu_01');
      assert.equal(result.is_error, 0);
      assert.equal(JSON.parse(result.content_json), '18C and clear');
    }
  );
});

test('unknown endpoints under a provider prefix proxy through unparsed (§14.2)', async () => {
  await withRig(
    (req, res) => jsonResponse(res, 200, { data: [{ id: 'claude-haiku-4-5' }] }),
    async ({ app, upstream }) => {
      const res = await fetch(`${app.origin}/anthropic/v1/models?limit=2`);
      assert.equal(res.status, 200);
      assert.equal(upstream.requests[0].url, '/v1/models?limit=2');

      assert.ok(await settle(app, () => app.store.countRuns() === 1));
      const call = app.store.callSummaries(app.store.listRuns().runs[0].id)[0];
      assert.equal(call.endpoint, '/v1/models');
      assert.equal(call.status, 200);
      assert.equal(call.model, null);
      assert.equal(call.cost_usd, null); // no model, no estimate (§08)
    }
  );
});

test('non-JSON upstream bodies are stored verbatim, never dropped (§14.2)', async () => {
  await withRig(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not json at all');
    },
    async ({ app }) => {
      const res = await fetch(`${app.origin}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(anthropicRequest)
      });
      assert.equal(await res.text(), 'not json at all');

      assert.ok(await settle(app, () => app.store.countRuns() === 1));
      const full = app.store.fullCalls(app.store.listRuns().runs[0].id)[0];
      const stored = JSON.parse(full.response_json);
      assert.equal(stored._orangebox.unparsed, true);
      assert.equal(stored.body, 'not json at all');
    }
  );
});

// ============================================================== streaming

test('a streamed Anthropic call is byte-identical and reassembles fully (§06.3, §17.1 check 2)', async () => {
  const transcript = fixture('anthropic-stream-tool-use.sse');

  await withRig(
    (req, res) => sseResponse(res, frames(transcript)),
    async ({ app }) => {
      const res = await fetch(`${app.origin}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...anthropicRequest, stream: true })
      });

      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      assert.equal(await res.text(), transcript, 'relayed bytes match upstream exactly');

      assert.ok(await settle(app, () => app.store.countRuns() === 1));
      const runId = app.store.listRuns().runs[0].id;
      const call = app.store.callSummaries(runId)[0];

      assert.equal(call.streamed, 1);
      assert.equal(call.error_type, null);
      assert.equal(call.model, 'claude-opus-5');
      assert.equal(call.stop_reason, 'tool_use');
      assert.equal(call.input_tokens, 143);
      assert.equal(call.output_tokens, 57);
      assert.equal(call.cache_read_tokens, 2048);
      assert.ok(call.cost_usd > 0);

      // §06.3 — TTFT is recorded and lands before the stream closes.
      assert.ok(call.ttft_ms !== null, 'ttft recorded');
      assert.ok(call.ttft_ms >= 0 && call.ttft_ms <= call.latency_ms);

      // §7.1 — the stored response is the canonical object, flagged as folded.
      const full = app.store.fullCalls(runId)[0];
      const stored = JSON.parse(full.response_json);
      assert.equal(stored._orangebox.reassembled_from_stream, true);
      assert.equal(stored.content[0].text, 'Let me check the weather.');
      assert.deepEqual(stored.content[1].input, { city: 'Paris' });

      // §7.4 — tool events come off the reassembled response like any other.
      const tools = app.store.toolEvents(runId);
      assert.equal(tools.length, 1);
      assert.equal(tools[0].kind, 'tool_use');
      assert.equal(tools[0].tool_name, 'get_weather');
    }
  );
});

test('a streamed OpenAI call reassembles, including terminal usage (§7.3)', async () => {
  const transcript = fixture('openai-stream-tool-use.sse');

  await withRig(
    (req, res) => sseResponse(res, frames(transcript)),
    async ({ app }) => {
      const res = await fetch(`${app.origin}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'user', content: 'weather in Paris?' }]
        })
      });
      assert.equal(await res.text(), transcript);

      assert.ok(await settle(app, () => app.store.countRuns() === 1));
      const runId = app.store.listRuns().runs[0].id;
      const call = app.store.callSummaries(runId)[0];

      assert.equal(call.streamed, 1);
      assert.equal(call.model, 'gpt-4o-mini-2024-07-18');
      assert.equal(call.stop_reason, 'tool_calls');
      assert.equal(call.input_tokens, 88);
      assert.equal(call.output_tokens, 31);
      assert.ok(call.ttft_ms !== null);

      const tools = app.store.toolEvents(runId);
      assert.equal(tools.length, 1);
      assert.deepEqual(JSON.parse(tools[0].content_json), { city: 'Paris' });
    }
  );
});

test('without include_usage, streamed token counts stay null (§7.3)', async () => {
  await withRig(
    (req, res) => sseResponse(res, frames(fixture('openai-stream-no-usage.sse'))),
    async ({ app }) => {
      const res = await fetch(`${app.origin}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', stream: true, messages: [] })
      });
      await res.text(); // drain, or the relay blocks on backpressure

      assert.ok(await settle(app, () => app.store.countRuns() === 1));
      const call = app.store.callSummaries(app.store.listRuns().runs[0].id)[0];
      assert.equal(call.input_tokens, null);
      assert.equal(call.output_tokens, null);
      assert.equal(call.cost_usd, null, 'no counts means no estimate, not $0.00');
      assert.equal(call.stop_reason, 'stop');
    }
  );
});

test('an error event mid-stream is recorded as upstream_stream_error (§14.1)', async () => {
  await withRig(
    (req, res) => sseResponse(res, frames(fixture('anthropic-stream-error.sse'))),
    async ({ app }) => {
      const res = await fetch(`${app.origin}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...anthropicRequest, stream: true })
      });
      // Whatever arrived is relayed as-is.
      assert.match(await res.text(), /overloaded_error/);

      assert.ok(await settle(app, () => app.store.countRuns() === 1));
      const runId = app.store.listRuns().runs[0].id;
      const call = app.store.callSummaries(runId)[0];
      assert.equal(call.error_type, 'upstream_stream_error');

      const stored = JSON.parse(app.store.fullCalls(runId)[0].response_json);
      assert.equal(stored.content[0].text, 'Halfway through this sen', 'partial content kept');
      assert.equal(stored._orangebox.stream_error.type, 'overloaded_error');
      assert.equal(app.store.getRun(runId).error_count, 1);
    }
  );
});

test('a client that walks away mid-stream is recorded as client_aborted (§17.1 check 5)', async () => {
  const all = frames(fixture('anthropic-stream-tool-use.sse'));

  // The abort has to land while the stream is genuinely open. Sleeping between
  // frames and hoping is not good enough: on a fast machine the whole body
  // arrives, the proxy calls res.end(), and there is no abort left to record —
  // which is why this test passed locally and failed on CI for days. So the
  // mock writes a couple of frames and then *blocks* until the test releases
  // it, taking timing out of the equation entirely.
  let releaseUpstream;
  const held = new Promise((resolve) => {
    releaseUpstream = resolve;
  });

  const upstream = await startMockUpstream(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(all[0]);
    res.write(all[1]);

    await held;

    for (const frame of all.slice(2)) {
      if (res.destroyed) break;
      res.write(frame);
    }
    if (!res.destroyed) res.end();
  });

  const app = await startOrangebox({
    providers: { anthropic: upstream.origin, openai: upstream.origin }
  });

  try {
    const ac = new AbortController();
    const res = await fetch(`${app.origin}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...anthropicRequest, stream: true }),
      signal: ac.signal
    });

    // Take the first chunk — which exists, because the mock wrote two frames
    // before blocking — then hang up like a killed agent process.
    const reader = res.body.getReader();
    await reader.read();
    ac.abort();
    await reader.cancel().catch(() => {});

    // Deliberately do NOT release the mock here. Releasing it lets the stream
    // finish, and if it finishes before the abort propagates the proxy records
    // a clean call — the exact race that made this test unreliable. The only
    // thing that should end this stream is orangebox aborting upstream, which
    // is what the real scenario looks like too.

    assert.ok(
      await settle(app, () => {
        if (app.store.countRuns() !== 1) return false;
        return app.store.callSummaries(app.store.listRuns().runs[0].id).length === 1;
      }),
      'the aborted call is still recorded'
    );

    const runId = app.store.listRuns().runs[0].id;
    const call = app.store.callSummaries(runId)[0];
    assert.equal(call.error_type, 'client_aborted');
    assert.equal(call.streamed, 1);

    const stored = JSON.parse(app.store.fullCalls(runId)[0].response_json);
    assert.equal(stored._orangebox.partial, true);
    assert.equal(stored._orangebox.reassembled_from_stream, true);

    // §17.1 check 5 — the server stays healthy afterwards.
    const health = await getJson(`${app.origin}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    // The captured transcript is a prefix of the full one — we hung up early.
    const captured = JSON.parse(app.store.fullCalls(runId)[0].response_json);
    assert.ok(
      captured.content.length === 0 || (captured.content[0].text ?? '').length < 'Let me check the weather.'.length,
      'only part of the stream was captured'
    );
  } finally {
    releaseUpstream(); // never leave the mock handler parked, even on failure
    await app.stop();
    await upstream.close();
  }
});

test('the live feed announces run, start, first token, and completion (§10.1)', async () => {
  await withRig(
    (req, res) => sseResponse(res, frames(fixture('anthropic-stream-tool-use.sse'))),
    async ({ app }) => {
      const ac = new AbortController();
      const feed = await fetch(`${app.origin}/api/live`, { signal: ac.signal });
      const reader = feed.body.getReader();
      const decoder = new TextDecoder();
      let seen = '';

      const collect = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            seen += decoder.decode(value, { stream: true });
            if (seen.includes('call.completed')) break;
          }
        } catch {
          /* aborted */
        }
      })();

      await fetch(`${app.origin}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...anthropicRequest, stream: true })
      });

      await Promise.race([collect, sleep(3000)]);
      ac.abort();

      for (const event of ['run.created', 'call.started', 'call.first_token', 'call.completed']) {
        assert.ok(seen.includes(`event: ${event}`), `missing ${event} in feed`);
      }
    }
  );
});

// ==================================================== api surface (§10)

test('export carries everything needed to understand a run (§10.6, §17.1 check 9)', async () => {
  await withRig(
    (req, res) => jsonResponse(res, 200, ANTHROPIC_MESSAGE),
    async ({ app }) => {
      await fetch(`${app.origin}/r/exported-run/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-LEAK-CANARY' },
        body: JSON.stringify(anthropicRequest)
      });
      assert.ok(await settle(app, () => app.store.callSummaries('exported-run').length === 1));

      const res = await fetch(`${app.origin}/api/export/exported-run`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition'), /attachment; filename="orangebox-run-exported-run\.json"/);

      const raw = await res.text();
      assert.equal(raw.includes('sk-ant-LEAK-CANARY'), false, 'exports carry prompts, never keys');

      const body = JSON.parse(raw);
      assert.equal(body.orangebox_export, 1);
      assert.ok(body.exported_at > 0);
      assert.equal(body.run.id, 'exported-run');
      assert.equal(body.calls.length, 1);
      // Unlike CallSummary, the export keeps the payloads — that is the point.
      assert.equal(typeof body.calls[0].request_json, 'string');
      assert.equal(typeof body.calls[0].response_json, 'string');
      assert.deepEqual(
        JSON.parse(body.calls[0].request_json).messages,
        anthropicRequest.messages
      );

      assert.equal((await fetch(`${app.origin}/api/export/nope`)).status, 404);
    }
  );
});

test('replay, comparison, sanitized sharing, and OTel export work end to end', async () => {
  await withRig(
    (req, res, raw) => {
      const request = JSON.parse(raw);
      jsonResponse(res, 200, {
        ...OPENAI_COMPLETION,
        model: request.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `echo:${request.messages.at(-1).content}` }, finish_reason: 'stop' }]
      });
    },
    async ({ app, upstream }) => {
      await fetch(`${app.origin}/r/original/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'internal instructions' },
            { role: 'user', content: 'contact dev@example.com' }
          ]
        })
      });
      assert.ok(await settle(app, () => app.store.callSummaries('original').length === 1));
      const original = app.store.callSummaries('original')[0];
      const csrf = (await getJson(`${app.origin}/api/health`)).body.csrf_token;

      const replayResponse = await fetch(`${app.origin}/api/calls/${original.id}/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orangebox-csrf': csrf },
        body: JSON.stringify({
          request: {
            model: 'gpt-4.1-mini',
            messages: [{ role: 'user', content: 'edited prompt' }]
          }
        })
      });
      assert.equal(replayResponse.status, 200);
      const replay = await replayResponse.json();
      assert.ok(replay.run_id);
      assert.ok(replay.call_id);
      assert.equal(upstream.requests.length, 2);
      assert.equal(JSON.parse(upstream.requests[1].body).messages[0].content, 'edited prompt');

      const comparison = await getJson(
        `${app.origin}/api/compare?left=original&right=${encodeURIComponent(replay.run_id)}`
      );
      assert.equal(comparison.status, 200);
      assert.equal(comparison.body.pairs.length, 1);
      assert.equal(comparison.body.pairs[0].delta.model_changed, true);

      const html = await fetch(`${app.origin}/api/export/original?format=html&sanitize=1`);
      assert.match(html.headers.get('content-type'), /text\/html/);
      const report = await html.text();
      assert.equal(report.includes('dev@example.com'), false);
      assert.equal(report.includes('internal instructions'), false);
      assert.ok(report.includes('[redacted-system-prompt]'));

      const otel = await getJson(`${app.origin}/api/export/original?format=otel`);
      assert.equal(otel.status, 200);
      const span = otel.body.resourceSpans[0].scopeSpans[0].spans[0];
      assert.equal(span.name.includes('gpt-4o-mini'), true);
    }
  );
});

test('runs survive a restart and deep links still resolve (§17.1 check 6)', async () => {
  const upstream = await startMockUpstream((req, res) => jsonResponse(res, 200, ANTHROPIC_MESSAGE));
  const first = await startOrangebox({
    providers: { anthropic: upstream.origin, openai: upstream.origin }
  });

  let dbPath;
  let runId;
  try {
    dbPath = first.dbPath;
    await fetch(`${first.origin}/r/persisted/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(anthropicRequest)
    });
    assert.ok(await settle(first, () => first.store.callSummaries('persisted').length === 1));
    runId = 'persisted';
    await first.close(); // close, but keep the database file
  } catch (err) {
    await first.stop();
    await upstream.close();
    throw err;
  }

  const { createServer } = await import('../src/server.mjs');
  const second = createServer({
    dbPath,
    providers: { anthropic: upstream.origin, openai: upstream.origin }
  });
  const addr = await second.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${addr.port}`;

  try {
    const { status, body } = await getJson(`${origin}/api/runs/${runId}`);
    assert.equal(status, 200);
    assert.equal(body.calls.length, 1, 'history intact across restart');
    assert.equal(body.calls[0].input_tokens, 12);

    // The deep link is an app route, so it serves the UI shell.
    const deep = await fetch(`${origin}/run/${runId}`);
    assert.equal(deep.status, 200);
    assert.match(deep.headers.get('content-type'), /text\/html/);
  } finally {
    await second.close();
    await upstream.close();
    await removeTempDir(path.dirname(dbPath));
  }
});

test('the UI is an installable PWA whose service worker never caches recorded data', async () => {
  const app = await startOrangebox();
  try {
    const index = await fetch(`${app.origin}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /class="mobile-nav"/);

    const manifestResponse = await fetch(`${app.origin}/manifest.webmanifest`);
    assert.match(manifestResponse.headers.get('content-type'), /application\/manifest\+json/);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.scope, '/');
    assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));

    const workerResponse = await fetch(`${app.origin}/service-worker.js`);
    assert.equal(workerResponse.headers.get('service-worker-allowed'), '/');
    const worker = await workerResponse.text();
    assert.match(worker, /url\.pathname\.startsWith\('\/api\/\'/);
    assert.match(worker, /Prompt data and live feeds must never enter browser-managed caches/);
    assert.doesNotMatch(worker.match(/const SHELL = \[[\s\S]*?\];/)?.[0] ?? '', /\/api\//);
  } finally {
    await app.stop();
  }
});

test('DELETE /api/runs/:id and POST /api/clear remove data (§10)', async () => {
  await withRig(
    (req, res) => jsonResponse(res, 200, ANTHROPIC_MESSAGE),
    async ({ app }) => {
      for (const id of ['run-x', 'run-y']) {
        await fetch(`${app.origin}/r/${id}/anthropic/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(anthropicRequest)
        });
      }
      assert.ok(await settle(app, () => app.store.countRuns() === 2));

      const csrf = (await getJson(`${app.origin}/api/health`)).body.csrf_token;
      const mutation = {
        headers: { 'content-type': 'application/json', 'x-orangebox-csrf': csrf },
        body: '{}'
      };
      assert.equal((await fetch(`${app.origin}/api/runs/run-x`, { method: 'DELETE', ...mutation })).status, 200);
      assert.equal(app.store.countRuns(), 1);
      assert.equal((await fetch(`${app.origin}/api/runs/run-x`, { method: 'DELETE', ...mutation })).status, 404);

      await fetch(`${app.origin}/api/clear`, { method: 'POST', ...mutation });
      assert.equal(app.store.countRuns(), 0);
    }
  );
});

test('mutating APIs require JSON, same origin, and the startup CSRF token', async () => {
  const app = await startOrangebox();
  try {
    const url = `${app.origin}/api/clear`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 415);
    assert.equal(
      (await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })).status,
      403
    );
    const csrf = (await getJson(`${app.origin}/api/health`)).body.csrf_token;
    assert.equal(
      (await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-orangebox-csrf': csrf,
          origin: 'https://attacker.example'
        },
        body: '{}'
      })).status,
      403
    );
    assert.equal(
      (await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orangebox-csrf': csrf },
        body: '{}'
      })).status,
      200
    );
  } finally {
    await app.stop();
  }
});

test('run API supports rename, tags, search, and pagination', async () => {
  const app = await startOrangebox();
  try {
    const health = (await getJson(`${app.origin}/api/health`)).body;
    const headers = {
      'content-type': 'application/json',
      'x-orangebox-csrf': health.csrf_token
    };
    const created = await getJson(`${app.origin}/api/runs/begin`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Before' })
    });
    const id = created.body.id;
    const updated = await getJson(`${app.origin}/api/runs/${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Checkout regression', tags: ['prod', 'payments'] })
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.run.name, 'Checkout regression');
    assert.deepEqual(updated.body.run.tags, ['prod', 'payments']);

    const found = await getJson(`${app.origin}/api/runs?search=payments&limit=1&offset=0`);
    assert.equal(found.body.total, 1);
    assert.equal(found.body.runs[0].id, id);
    const missing = await getJson(`${app.origin}/api/runs?search=missing`);
    assert.equal(missing.body.total, 0);
  } finally {
    await app.stop();
  }
});

test('optional remote auth protects API and proxy routes without leaking upstream', async () => {
  const upstream = await startMockUpstream((req, res) => jsonResponse(res, 200, ANTHROPIC_MESSAGE));
  const app = await startOrangebox({
    providers: { anthropic: upstream.origin, openai: upstream.origin },
    authToken: 'review-token'
  });
  try {
    assert.equal((await fetch(`${app.origin}/api/health`)).status, 401);
    assert.equal(
      (await fetch(`${app.origin}/api/health`, {
        headers: { 'x-orangebox-auth': 'review-token' }
      })).status,
      200
    );
    const response = await fetch(`${app.origin}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-orangebox-auth': 'review-token'
      },
      body: JSON.stringify(anthropicRequest)
    });
    assert.equal(response.status, 200);
    assert.equal(upstream.requests[0].headers['x-orangebox-auth'], undefined);
  } finally {
    await app.stop();
    await upstream.close();
  }
});

test('unknown routes 404 with the routing hint (§04)', async () => {
  const app = await startOrangebox();
  try {
    const { status, body } = await getJson(`${app.origin}/not-a-thing`);
    assert.equal(status, 404);
    assert.equal(body.error, 'unknown route');
    assert.match(body.hint, /\/anthropic or \/openai/);
  } finally {
    await app.stop();
  }
});
