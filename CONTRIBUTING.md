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
| `src/parse/*.mjs` | Per-provider request/response mapping, stream reassembly, and first-token detection. Adding a provider means one file here plus a route prefix — see the note below. |
| `src/store.mjs` | Schema, transactions, queries, redaction, truncation. |
| `src/live.mjs` | SSE hub. |
| `src/pricing.*` | Rate table and longest-prefix lookup. |
| `ui/` | The web UI. No framework, no build step, no third-party anything. |
| `examples/demo-agent.mjs` | Scripted agent producing the canonical three-call run. Needs a real `ANTHROPIC_API_KEY`. |
| `docs/` | Source of the website. The live copy is deployed from the EzraStone/orangebox-Website repo via Vercel. |

`docs/spec.html` is a **copy** of the canonical `orangebox-spec.html` at the
repo root — the site is deployed from its own repo, which needs the spec
alongside the page rather than one directory up. Edit the root file, then run
`npm run docs:sync`. CI runs `npm run docs:check` and fails if you forget, so
the published spec cannot quietly describe a different product from the code.

Preview the site with `npm run docs:serve`.

The SVGs in `docs/img/` are hand-drawn to match the real UI and are shared by the
README and the website; if the UI's look changes, they need redrawing. `demo.svg`
is the animated one — a CSS-driven 18 s loop standing in for a screen capture.
Two rules keep it working: XML forbids `--` inside a comment (a `<!-- ---- -->`
rule silently breaks the whole file when loaded as an `<img>`, which is how
GitHub renders it), and every reveal shares one 18 s cycle so the storyboard
stays in step.

The full build specification is [`orangebox-spec.html`](orangebox-spec.html).
Section references in code comments (`§06.3`, `§14.2`) point into it.

## Adding a provider

One file in `src/parse/`, exporting six functions — **and six other places**.
That list is not padding: Gemini, Ollama and Bedrock each shipped a release
having missed at least one of them.

1. `src/parse/<provider>.mjs` — the six exports below
2. `PARSERS` in `src/proxy.mjs`
3. `PROVIDERS` in `src/server.mjs` — the routing table is *derived* from this,
   so adding it here is what makes the provider routable
4. `providersFrom()` in `src/cli.mjs` — spreads `PROVIDERS`, so usually free,
   but add a `--<provider>-upstream` flag
5. `runScopedEnv()` in `src/cli.mjs` — the variable an SDK reads to find us
6. `PROVIDER_CREDENTIALS` in `src/credentials.mjs` — how replay authenticates
7. `src/pricing.json` — or the provider records as unpriced, which is honest
   but unhelpful

Three tests already fail if you miss 3, 4, 5 or 6. Run `npm test` and believe
it over this list.
 `ollama.mjs` is the shortest example
and the least like the others — it speaks newline-delimited JSON rather than
SSE, which is the point: nothing outside the parser should know that.

| Export | Answers |
| --- | --- |
| `parseRequest(json)` | model, and is this a stream? |
| `parseResponse(json)` | model, stop reason, token counts |
| `reassembleStream(text)` | fold a captured transcript into the non-streamed shape |
| `firstTokenSeen(buffered)` | has content started? (drives TTFT) |
| `extractToolUses(response)` | tool calls the model made |
| `extractToolResults(request)` | results the client sent back |

`firstTokenSeen` is easy to forget and fails quietly — the TTFT column simply
stays empty for your provider and nothing complains. Write the end-to-end test,
not only the parser unit tests; that is what caught it for Ollama.

Every function must degrade rather than throw. An unrecognised shape returns
nulls or an empty array; a record with missing fields beats no record.

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

## When two lists have to agree, write the test

Nearly every bug this project has shipped has been the same shape: two places
that must stay in step, kept in step by remembering. Routes and upstreams.
Providers and their environment variables. Dispatched commands and `--help`.
UI modules and the offline precache list.

They are nasty because the symptom never points at the cause. Three providers
proxied to `undefined/...` for a whole release with a green test suite,
because every test built the server in-process and skipped the code that turns
flags into configuration.

So: if you add a thing that must appear in two places, add a test that derives
one from the other. `test/cli.test.mjs` and `test/shell.test.mjs` have several
to copy. Confirm it fails before you make it pass — a drift test that never
bites is worse than none, because it reads like coverage.

## Manual probes

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
