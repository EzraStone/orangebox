#!/usr/bin/env node
// A complete orangebox demo that needs no API key and touches no network.
//
//   node examples/demo-offline.mjs
//
// It starts a fake provider on loopback, starts orangebox pointed at it, seeds
// two realistic runs, and stays up so you can explore the UI and curl the proxy
// yourself. Everything lives in a throwaway database, so your real recordings
// in ~/.orangebox are untouched.
//
// The fake provider reacts to the model name so you can exercise the failure
// paths without waiting for a real one to rate-limit you:
//
//   model contains "429"    → 429 rate_limit_error, with retry-after
//   model contains "500"    → 500 api_error
//   model contains "slow"   → responds after 3 s (try killing the client)
//   model contains "die"    → streams a few frames, then an SSE error event
//   stream: true            → server-sent events
//   anything else           → an ordinary JSON completion
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { createServer } = await import(new URL('../src/server.mjs', import.meta.url));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const PORT = Number(flag('--port', 4100));
const KEEP = !args.includes('--exit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-demo-'));

// ===================================================== the fake provider

const PLAN = {
  id: 'msg_01Plan',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [
    {
      type: 'text',
      text: "I'll look up the current weather for both cities, then compare them.\n\nLet me fetch Paris first."
    }
  ],
  stop_reason: 'end_turn',
  usage: { input_tokens: 2412, output_tokens: 38, cache_read_input_tokens: 0, cache_creation_input_tokens: 1800 }
};

const TOOL_TURN = {
  id: 'msg_02Tool',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [
    { type: 'text', text: 'Fetching both in parallel.' },
    { type: 'tool_use', id: 'toolu_01Paris', name: 'get_weather', input: { city: 'Paris', units: 'metric' } },
    { type: 'tool_use', id: 'toolu_02Oslo', name: 'get_weather', input: { city: 'Oslo', units: 'metric' } }
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 2680, output_tokens: 114, cache_read_input_tokens: 1800, cache_creation_input_tokens: 0 }
};

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function streamFrames({ die = false } = {}) {
  const words = die
    ? ['Paris is ', '18 °C and cle']
    : ['Paris is ', '18 °C and clear; ', 'Oslo is 6 °C ', 'with light rain.\n\n', 'Paris is 12 degrees warmer ', 'and the better bet ', 'for an evening outdoors.'];

  const frames = [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_03Synth', type: 'message', role: 'assistant', model: 'claude-opus-5',
        content: [], stop_reason: null,
        usage: { input_tokens: 6103, output_tokens: 1, cache_read_input_tokens: 1800, cache_creation_input_tokens: 0 }
      }
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('ping', { type: 'ping' }),
    ...words.map((text) =>
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    )
  ];

  if (die) {
    frames.push(sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    return frames;
  }

  frames.push(
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 289 } }),
    sse('message_stop', { type: 'message_stop' })
  );
  return frames;
}

let turn = 0;

const provider = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    /* the proxy must survive junk too */
  }

  const model = String(body.model ?? '');
  const json = (status, payload, extra = {}) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extra });
    res.end(text);
  };

  if (model.includes('429')) {
    return json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit.' } }, { 'retry-after': '2' });
  }
  if (model.includes('500')) {
    return json(500, { type: 'error', error: { type: 'api_error', message: 'Internal server error' } });
  }
  if (model.includes('slow')) await sleep(3000);

  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const frame of streamFrames({ die: model.includes('die') })) {
      if (res.destroyed) return;
      res.write(frame);
      await sleep(60); // slow enough to watch, and to interrupt
    }
    return res.end();
  }

  // Alternate plan / tool-turn so a scripted conversation looks like one.
  const payload = turn++ % 2 === 0 ? PLAN : TOOL_TURN;
  await sleep(turn % 2 === 0 ? 1400 : 900);
  json(200, payload);
});

await new Promise((r) => provider.listen(0, '127.0.0.1', r));
const upstream = `http://127.0.0.1:${provider.address().port}`;

// ========================================================== orangebox

const app = createServer({
  dbPath: path.join(dbDir, 'demo.db'),
  gapSeconds: 120,
  providers: { anthropic: upstream, openai: upstream }
});

try {
  await app.listen(PORT, '127.0.0.1');
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is busy — something is already listening there.`);
    console.error(`Stop it, or run the demo elsewhere:  node examples/demo-offline.mjs --port 4101\n`);
    process.exit(1);
  }
  throw err;
}

const origin = `http://127.0.0.1:${PORT}`;

// ========================================================= seed the runs

const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-demo-key-not-real', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });

async function beginRun(name) {
  const res = await post(`${origin}/api/runs/begin`, { name });
  return (await res.json()).id;
}

const SYSTEM =
  'You are a concise travel assistant. Use the get_weather tool for any city the user names — never guess. ' +
  'Answer in two short sentences and say plainly which city is the better bet.';

const TOOLS = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string' }, units: { type: 'string', enum: ['metric', 'imperial'] } },
      required: ['city']
    }
  }
];

console.log('\n  seeding two runs against a fake provider (no network, no API key)…');

// --- run 1: the canonical plan → tool loop → streamed synthesis
const runId = await beginRun('weather comparison agent');
const base = `${origin}/r/${runId}/anthropic/v1/messages`;

const m1 = [{ role: 'user', content: 'Compare the weather in Paris and Oslo right now. Which is better for an evening outdoors?' }];
await (await post(base, { model: 'claude-opus-5', max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages: m1 })).text();

const m2 = [...m1, { role: 'assistant', content: PLAN.content }, { role: 'user', content: 'Go ahead.' }];
await (await post(base, { model: 'claude-opus-5', max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages: m2 })).text();

// The agent runs its tools here. orangebox never sees them execute — only the
// results — so this wall-clock hole is what the UI labels "client-side ≈".
await sleep(2100);

const m3 = [
  ...m2,
  { role: 'assistant', content: TOOL_TURN.content },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_01Paris', content: '{"city":"Paris","temp_c":18,"conditions":"clear","wind_kph":9}' },
      { type: 'tool_result', tool_use_id: 'toolu_02Oslo', content: 'upstream weather provider returned 503', is_error: true }
    ]
  }
];
await (await post(base, { model: 'claude-opus-5', max_tokens: 1024, stream: true, system: SYSTEM, tools: TOOLS, messages: m3 })).text();
await post(`${origin}/api/runs/${runId}/end`, {});

// --- run 2: a retry storm, so the UI has an error state to show
const retryId = await beginRun('retry storm repro');
const retryBase = `${origin}/r/${retryId}/anthropic/v1/messages`;
const ask = [{ role: 'user', content: 'summarise this document' }];

await (await post(retryBase, { model: 'claude-opus-5-429', max_tokens: 512, messages: ask })).text();
await (await post(retryBase, { model: 'claude-opus-5-429', max_tokens: 512, messages: ask })).text();
await (await post(retryBase, { model: 'claude-opus-5', max_tokens: 512, messages: ask })).text();
await post(`${origin}/api/runs/${retryId}/end`, {});

// ================================================================ report

const runs = app.store.countRuns();
console.log(`  seeded ${runs} runs into ${app.store.path}\n`);
console.log(`  ▮ open the UI          ${origin}/run/${runId}`);
console.log(`  ▮ the retry storm      ${origin}/run/${retryId}`);
console.log(`  ▮ health               ${origin}/api/health`);
console.log('');
console.log('  Things to try in the UI:');
console.log('    · click call 02 → Conversation — the exact prompt, with tool_use cards');
console.log('    · click call 03 → Diff — what the prompt gained since call 02');
console.log('    · click call 03 → Timing — real time-to-first-token on the streamed call');
console.log('    · j / k to move between calls, enter to open, esc to close');
console.log('');
console.log('  Or drive the proxy yourself — this is a real proxy, just pointed at a fake provider:');
console.log('');
console.log(`    curl -s ${origin}/anthropic/v1/messages \\`);
console.log(`      -H 'content-type: application/json' -H 'x-api-key: sk-ant-fake' \\`);
console.log(`      -d '{"model":"claude-opus-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'`);
console.log('');
console.log('    Swap the model for claude-opus-5-429 / -500 / -slow / -die to exercise the failure paths.');
console.log('    Add "stream":true for server-sent events.');
console.log('');

if (!KEEP) {
  await app.close();
  await new Promise((r) => provider.close(r));
  fs.rmSync(dbDir, { recursive: true, force: true });
  process.exit(0);
}

console.log('  Ctrl-C to stop. The demo database is temporary and is deleted on exit.\n');

const shutdown = async () => {
  console.log('\n  cleaning up…');
  await app.close();
  await new Promise((r) => provider.close(r));
  fs.rmSync(dbDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
