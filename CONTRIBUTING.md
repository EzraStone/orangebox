# Contributing to orangebox

## Getting set up

Node 20 or newer. One runtime dependency.

```bash
npm install
npm test
node bin/orangebox.mjs --no-open --db ./scratch.db
```

The test suite never touches the network — every "upstream" is a `node:http`
server on loopback. If a change makes a test need real network access, the
change is wrong.

## Layout

| Path | What lives there |
| --- | --- |
| `bin/orangebox.mjs` | Shebang shim; delegates to `src/cli.mjs`. |
| `src/cli.mjs` | Argument parsing, `start` / `run` / `export` / `clear`. |
| `src/server.mjs` | HTTP server, routing table, the internal JSON API, static UI. |
| `src/proxy.mjs` | Forwarding, teeing, timing, run attribution, record assembly. |
| `src/parse/*.mjs` | Per-provider request/response mapping and stream reassembly. |
| `src/store.mjs` | Schema, transactions, queries, redaction, truncation. |
| `src/live.mjs` | SSE hub. |
| `src/pricing.*` | Rate table and longest-prefix lookup. |
| `ui/` | The web UI. No framework, no build step, no third-party anything. |
| `examples/demo-agent.mjs` | Scripted agent producing the canonical three-call run. Needs a real `ANTHROPIC_API_KEY`. |
| `examples/demo-offline.mjs` | The same shape against a fake provider — no key, no network. Start here. |
| `docs/` | The published website (GitHub Pages serves this folder). |

`docs/spec.html` is a **copy** of the canonical `orangebox-spec.html` at the
repo root, because Pages can only serve what is inside `docs/`. Edit the root
file, then run `npm run docs:sync` so the published copy matches. Preview the
site locally with `npm run docs:serve`.

The four SVGs in `docs/img/` are hand-drawn to match the real UI and are used by
both the README and the website; if the UI's look changes, they need updating.

The full build specification is [`orangebox-spec.html`](orangebox-spec.html).
Section references in code comments (`§06.3`, `§14.2`) point into it.

## Rules that are not negotiable

- **Never add latency to the hot path.** Parsing and database writes happen
  after the client's response has finished. Streamed chunks are written
  through the instant they arrive.
- **Never lose a record because parsing failed.** Unrecognized shapes degrade
  to raw storage with null extractions. Never a throw, never a dropped call.
- **Never store credentials.** Persisted headers are an allowlist, and anything
  matching `/auth|key|token|secret|cookie/i` is dropped even if allowlisted by
  mistake. Verify with the grep probe below before shipping.
- **Never `innerHTML` in the UI.** Prompts are untrusted input; all recorded
  content goes in via `textContent`.
- **No new runtime dependencies.** One is the budget and it is spent.
- **No telemetry, ever.** Not a version check, not an anonymous ping. Ever.

## Manual probes

### Without an API key

`node examples/demo-offline.mjs` starts a fake provider, points orangebox at it,
and seeds two runs. Because it is a *real* proxy pointed at a *fake* provider,
every probe below works against it — swap the model name to pick the response:

| Model contains | Fake provider returns |
| --- | --- |
| `429` | 429 `rate_limit_error` with `retry-after` |
| `500` | 500 `api_error` |
| `slow` | a normal reply after 3 s |
| `die` | a few SSE frames, then an `error` event |
| anything, `"stream": true` | server-sent events |

```bash
# recorded as http_429, relayed to the client verbatim
curl -s -D - -o /dev/null http://127.0.0.1:4100/anthropic/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-opus-5-429","max_tokens":16,"messages":[]}'
```

### Against the real providers

Start the recorder first:

```bash
node bin/orangebox.mjs --no-open
```

Non-streamed, Anthropic (requires `ANTHROPIC_API_KEY` in the environment):

```bash
curl -s http://127.0.0.1:4100/anthropic/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":64,
       "messages":[{"role":"user","content":"say ping"}]}'
```

Streamed, OpenAI:

```bash
curl -sN http://127.0.0.1:4100/openai/v1/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","stream":true,
       "stream_options":{"include_usage":true},
       "messages":[{"role":"user","content":"say ping"}]}'
```

The full three-call tool-loop shape:

```bash
node bin/orangebox.mjs run --name "weather agent" -- node examples/demo-agent.mjs
```

No key should ever appear in the database:

```bash
grep -c "$ANTHROPIC_API_KEY" ~/.orangebox/orangebox.db    # must print 0
```

Byte fidelity — the proxied response must be identical to the direct one:

```bash
diff <(curl -s https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" \
        -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
        -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"say ping"}],"temperature":0}') \
     <(curl -s http://127.0.0.1:4100/anthropic/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" \
        -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
        -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"say ping"}],"temperature":0}')
```

Only the generated text and ids should differ; headers, shape, and status must
match. (Sampling makes the text itself non-deterministic — the automated
byte-fidelity check in `test/proxy.test.mjs` uses a fixed mock upstream.)

Kill an agent mid-stream and confirm the call is recorded as `client_aborted`
with partial content, and that `/api/health` still answers.

## Pull requests

Keep the diff small and the tests green on Node 20, 22, and 24. If you deviate
from the specification, say so in a code comment and in the commit message,
with the reason.
