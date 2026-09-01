// §13 — measure the numbers the README claims, so they can be re-checked
// rather than remembered.
//
// Deliberately NOT part of `npm test`. These are wall-clock measurements on
// whatever machine happens to be running them, and a shared CI runner under
// load would fail them for reasons that have nothing to do with orangebox. A
// flaky performance test is worse than none: it teaches people to re-run the
// suite until it passes, which is how a real regression gets waved through.
//
// So this reports, and exits non-zero only on an egregious miss — several times
// the budget, which is a regression rather than a noisy neighbour.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';

/** How far past budget counts as broken rather than busy. */
const ALARM_FACTOR = 4;

const results = [];

function record(name, measured, budget, unit) {
  results.push({ name, measured, budget, unit });
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function withRig(handler, run) {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handler(req, res));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-bench-'));
  const app = createServer({
    dbPath: path.join(dir, 'bench.db'),
    providers: { anthropic: upstreamOrigin, openai: upstreamOrigin }
  });
  const address = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    return await run({ origin, upstreamOrigin, app });
  } finally {
    await app.close();
    await new Promise((r) => upstream.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const JSON_BODY = JSON.stringify({
  id: 'msg_bench', model: 'claude-opus-5', role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1000, output_tokens: 50 }
});

/**
 * §13.1 — what the proxy adds to a non-streamed call.
 *
 * Measured as the difference between going through orangebox and going
 * straight to the same upstream, in the same process, interleaved. Measuring
 * them separately would fold in whatever else the machine was doing between
 * the two batches.
 */
async function benchAddedLatency() {
  await withRig(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON_BODY);
    },
    async ({ origin, upstreamOrigin }) => {
      const body = JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] });
      const post = async (base, suffix) => {
        const started = performance.now();
        const res = await fetch(base + suffix, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body
        });
        await res.text();
        return performance.now() - started;
      };

      // Warm both paths so JIT and connection setup are not in the numbers.
      for (let i = 0; i < 30; i++) {
        await post(origin, '/anthropic/v1/messages');
        await post(upstreamOrigin, '/v1/messages');
      }

      const direct = [];
      const proxied = [];
      for (let i = 0; i < 200; i++) {
        proxied.push(await post(origin, '/anthropic/v1/messages'));
        direct.push(await post(upstreamOrigin, '/v1/messages'));
      }

      record('added latency, non-streamed', percentile(proxied, 0.5) - percentile(direct, 0.5), 5, 'ms');
    }
  );
}

/**
 * §13.3 — how long after the response finishes before the call is queryable.
 * Recording happens off the hot path, so this is the lag that matters for the
 * live timeline rather than for the agent.
 */
async function benchTimeToRecorded() {
  await withRig(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON_BODY);
    },
    async ({ origin, app }) => {
      const lags = [];
      for (let i = 0; i < 50; i++) {
        const before = app.store.countRuns();
        const started = performance.now();
        await fetch(`${origin}/anthropic/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-orangebox-run-id': `bench-${i}` },
          body: JSON.stringify({ model: 'claude-opus-5', messages: [] })
        }).then((r) => r.text());

        while (app.store.countRuns() === before) await new Promise((r) => setImmediate(r));
        lags.push(performance.now() - started);
      }
      record('request to recorded', percentile(lags, 0.5), 150, 'ms');
    }
  );
}

/**
 * §13.2 — event-loop lag while relaying many streams at once.
 *
 * This is the number that matters most: orangebox writes each chunk through
 * immediately and copies it aside, so a stall here would be felt by every
 * agent connected at the time, not just the one being recorded.
 */
async function benchStreamLag() {
  const NL = String.fromCharCode(10);
  const frames = [
    `event: message_start${NL}data: ${JSON.stringify({ type: 'message_start', message: { id: 'm', model: 'claude-opus-5', usage: { input_tokens: 10 } } })}${NL}${NL}`,
    ...Array.from({ length: 40 }, (_, i) =>
      `event: content_block_delta${NL}data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `chunk ${i} ` } })}${NL}${NL}`
    ),
    `event: message_stop${NL}data: ${JSON.stringify({ type: 'message_stop' })}${NL}${NL}`
  ];

  await withRig(
    async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of frames) {
        res.write(frame);
        await new Promise((r) => setTimeout(r, 1));
      }
      res.end();
    },
    async ({ origin }) => {
      let worst = 0;
      let last = performance.now();
      const tick = setInterval(() => {
        const now = performance.now();
        worst = Math.max(worst, now - last - 5);
        last = now;
      }, 5);

      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          fetch(`${origin}/anthropic/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'claude-opus-5', stream: true, messages: [{ role: 'user', content: `s${i}` }] })
          }).then((r) => r.text())
        )
      );

      clearInterval(tick);
      record('event-loop lag, 50 streams', worst, 50, 'ms');
    }
  );
}

/** §13.4 — how long the API takes to hand the UI a large run. */
async function benchLargeRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-bench-ui-'));
  const app = createServer({ dbPath: path.join(dir, 'big.db') });
  const address = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const { newId } = await import('../src/store.mjs');
    const run = app.store.createRun({ name: 'big run', source: 'explicit' });

    app.store.db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        app.store.insertCall({
          id: newId(), run_id: run.id, seq: i + 1,
          provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
          started_at: Date.now() + i, ended_at: Date.now() + i + 900,
          latency_ms: 900, input_tokens: 1000, output_tokens: 50, cost_usd: 0.001,
          request_json: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(200) }] }),
          response_json: JSON.stringify({ content: [{ type: 'text', text: 'y'.repeat(200) }] })
        });
      }
    })();

    // Warm, then measure the request the UI actually makes to open a run.
    for (let i = 0; i < 3; i++) await fetch(`${origin}/api/runs/${run.id}`).then((r) => r.json());

    const times = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const body = await fetch(`${origin}/api/runs/${run.id}`).then((r) => r.json());
      times.push(performance.now() - started);
      if (body.calls.length !== 1000) throw new Error(`expected 1000 calls, got ${body.calls.length}`);
    }

    record('open a 1000-call run', percentile(times, 0.5), 500, 'ms');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await benchAddedLatency();
await benchTimeToRecorded();
await benchStreamLag();
await benchLargeRun();

const pad = (s, n) => String(s).padEnd(n);
console.log();
console.log(`  ${pad('measurement', 30)} ${pad('measured', 12)} ${pad('budget', 10)} status`);
console.log();

let alarms = 0;
for (const r of results) {
  const over = r.measured > r.budget;
  const bad = r.measured > r.budget * ALARM_FACTOR;
  if (bad) alarms++;
  const status = bad ? 'REGRESSION' : over ? 'over budget (machine noise?)' : 'ok';
  console.log(`  ${pad(r.name, 30)} ${pad(`${r.measured.toFixed(2)} ${r.unit}`, 12)} ${pad(`< ${r.budget} ${r.unit}`, 10)} ${status}`);
}
console.log();
console.log(`  measured on node ${process.version}, ${os.platform()}/${os.arch()}, ${os.cpus().length} cores`);
console.log(`  these are wall-clock numbers on one machine — treat a single "over budget" as noise, not evidence`);
console.log();

if (alarms > 0) {
  console.error(`  ${alarms} measurement(s) exceeded ${ALARM_FACTOR}x their budget`);
  process.exitCode = 1;
}
