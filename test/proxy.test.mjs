// §17.1 — integration tests against a mock upstream. No real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  startMockUpstream,
  startOrangebox,
  jsonResponse,
  getJson,
  settle,
  ANTHROPIC_MESSAGE,
  OPENAI_COMPLETION
} from './helpers.mjs';

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
        headers: { 'content-type': 'application/json' },
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
