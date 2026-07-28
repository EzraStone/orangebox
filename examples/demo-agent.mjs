#!/usr/bin/env node
// §17.2 — a small scripted agent that produces exactly the plan → tool loop →
// synthesize shape in FIG. 0, so the README GIF, the acceptance checks, and
// every first-time user see the same representative run.
//
// It talks to the Messages API with plain fetch rather than the Anthropic SDK.
// The spec's parenthetical suggests the SDK; using fetch keeps `npm install`
// at a single package and makes the point the product is actually selling —
// orangebox sits at the HTTP layer, so the client library is irrelevant.
//
//   node bin/orangebox.mjs                       # terminal 1
//   ANTHROPIC_BASE_URL=http://127.0.0.1:4100/anthropic \
//     ANTHROPIC_API_KEY=sk-ant-... node examples/demo-agent.mjs
//
// or, without touching an environment variable yourself:
//
//   node bin/orangebox.mjs run --name "weather agent" -- node examples/demo-agent.mjs

const BASE = (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.DEMO_MODEL ?? 'claude-opus-5';

if (!API_KEY) {
  console.error('demo-agent: set ANTHROPIC_API_KEY first.');
  process.exit(1);
}

const TOOLS = [
  {
    name: 'get_weather',
    description:
      'Get the current weather for a city. Returns temperature in Celsius, sky conditions, and wind speed.',
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, e.g. "Paris"' }
      },
      required: ['city']
    }
  }
];

/** The one tool, executed locally. Fake data, real shape. */
function getWeather({ city }) {
  const table = {
    paris: { temp_c: 18, conditions: 'clear', wind_kph: 9 },
    oslo: { temp_c: 6, conditions: 'light rain', wind_kph: 21 },
    lisbon: { temp_c: 24, conditions: 'sunny', wind_kph: 14 }
  };
  const hit = table[String(city).toLowerCase()];
  if (!hit) throw new Error(`no weather station for "${city}"`);
  return { city, ...hit };
}

async function messages(body) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  return res.json();
}

/** Streamed turn: consume the SSE and reassemble just the text, like a UI would. */
async function messagesStream(body) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ ...body, stream: true })
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`);

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        const event = JSON.parse(line.slice(5).trim());
        const delta = event?.delta?.text;
        if (typeof delta === 'string') {
          text += delta;
          process.stdout.write(delta);
        }
      } catch {
        /* ignore partial frames */
      }
    }
  }
  process.stdout.write('\n');
  return text;
}

const SYSTEM =
  'You are a concise travel assistant. Use the get_weather tool for any city the user names — never guess. ' +
  'When you have the data, answer in two short sentences and say plainly which city is the better bet.';

const conversation = [
  {
    role: 'user',
    content:
      'Compare the weather in Paris and Oslo right now, then tell me which is the better bet for an evening outdoors.'
  }
];

console.log('▮ call 01 — plan');
const plan = await messages({
  model: MODEL,
  max_tokens: 1024,
  system: SYSTEM,
  tools: TOOLS,
  messages: conversation
});
conversation.push({ role: 'assistant', content: plan.content });
for (const block of plan.content) {
  if (block.type === 'text') console.log(`   ${block.text.trim().split('\n')[0]}`);
}

// Tool loop: keep answering tool_use turns until the model stops asking.
let turn = plan;
let round = 0;
while (turn.stop_reason === 'tool_use' && round++ < 4) {
  const uses = turn.content.filter((b) => b.type === 'tool_use');
  console.log(`▮ call 0${round + 1} — tool loop (${uses.map((u) => u.name).join(', ')})`);

  const results = uses.map((use) => {
    try {
      return {
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(getWeather(use.input))
      };
    } catch (err) {
      return {
        type: 'tool_result',
        tool_use_id: use.id,
        content: String(err.message),
        is_error: true
      };
    }
  });

  conversation.push({ role: 'user', content: results });

  turn = await messages({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    tools: TOOLS,
    messages: conversation
  });
  conversation.push({ role: 'assistant', content: turn.content });
}

// Final turn, streamed — the timeline gets a live node with a real TTFT.
conversation.push({ role: 'user', content: 'Now give me the two-sentence summary.' });
console.log(`▮ call 0${round + 2} — synthesize (streamed)`);
await messagesStream({
  model: MODEL,
  max_tokens: 1024,
  system: SYSTEM,
  tools: TOOLS,
  messages: conversation
});

console.log('\n▮ done — open the timeline to see what actually happened.');
