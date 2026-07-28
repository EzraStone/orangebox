# 🟧 orangebox — *the flight recorder for AI agents*

A local proxy that records every LLM API call your agent makes and renders each run as a visual timeline you can inspect forever.

[![CI](https://github.com/EzraStone/orangebox/actions/workflows/ci.yml/badge.svg)](https://github.com/EzraStone/orangebox/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/orangebox.svg)](https://www.npmjs.com/package/orangebox)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<!-- TODO before launch: replace the figure below with the demo GIF.
     ~1280x720, under 15 MB, whole loop under 25 seconds: split-screen of
     `npx orangebox` + `node examples/demo-agent.mjs` with the timeline
     filling live, ending on the detail drawer. -->

```
 T+0.0s        T+4.1s              T+11.6s                T+19.8s      T+27.4s
 │             │                   │                      │            │
 ● call 01 · plan          1.9s · 2.4k tok · $0.024
 │
 ● call 02 · tool loop     3.2s · stop: tool_use
 ├─▪ web_search  ▪ web_fetch        client-side ≈ 2.1s
 │
 ◌ call 03 · synthesize    4.7s · 6.1k tok · $0.041 · ttft 108 ms  ▮ streaming
```

---

## Quickstart

```bash
npx orangebox
```

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:4100/anthropic"   # then run your agent
```

That's it. The UI opens at <http://127.0.0.1:4100> and fills in as your agent runs.

Prefer not to touch environment variables? Let orangebox set them for you, and get precise run boundaries for free:

```bash
npx orangebox run --name "checkout bot" -- node agent.js
```

## Why

- **Zero code changes.** One environment variable, or none at all with `orangebox run`. Nothing to instrument, nothing to forget.
- **Fully local. No account, no telemetry, no cloud.** Your prompts go into one SQLite file on your machine and nowhere else. The process makes no network calls except forwarding yours upstream.
- **Works with any language or framework.** It's just HTTP — Python, JS, Go, curl, LangChain, whatever. orangebox sits at the wire, so it cannot be bypassed by a client library it has never heard of.

## What you get

**A timeline of the whole run.** Every call in order, with latency, token counts, stop reason, and estimated cost. A 40-second tool gap or a 3× retry storm is visible without reading anything.

**The exact prompt the model saw.** Click any call and read the full message history at that moment — system prompt, every turn, tool results injected — as the model received it, not as you think you assembled it.

**Tool calls, paired.** `tool_use` blocks and the `tool_result` that answered them, linked, with errors flagged. The wall-clock gap between calls is labelled "client-side ≈" because orangebox sees the result, not the execution.

**Streaming, faithfully.** Chunks are relayed the instant they arrive — the recorder adds no measurable latency — then the captured transcript is folded back into a normal response object so a streamed call reads exactly like a non-streamed one. Time-to-first-token is recorded per call.

**Cost, labelled honestly.** Token counts × the rates in `src/pricing.json`. Always shown as "est.", never as billing truth. Unpriced model or missing counts? You get an em-dash and a tooltip saying which, not a confident $0.00.

<!-- TODO before launch: one screenshot per feature (timeline, detail drawer, cost). -->

## How it works

```
       your agent (any language)
       ANTHROPIC_BASE_URL=http://127.0.0.1:4100/anthropic
                  │
                  ▼
   ┌──────────────────────────────────┐
   │  orangebox · one Node process    │
   │                                  │
   │   proxy ──tee──▶ parser ──▶ SQLite
   │     │                        │   │
   │     │ bytes, unmodified      ▼   │
   │     │              JSON API + SSE│◀── browser UI
   └─────┼──────────────────────────┬─┘
         ▼                          
   api.anthropic.com / api.openai.com
```

One process, one port. Requests are proxied through untouched and teed to a parser that writes a normalized record to `~/.orangebox/orangebox.db`. The same port serves the UI, a JSON API, and a live SSE feed so the timeline updates while your agent is still running.

Recording happens **after** your client's response is finished — never in the hot path.

## CLI

| Command | What it does |
| --- | --- |
| `orangebox` | Start recording (default command). |
| `orangebox run [--name "…"] -- CMD` | Run `CMD` with `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` pointed at a run-scoped prefix, so its calls group exactly. Exits with the child's exit code. |
| `orangebox export <run-id> [-o file]` | Write a self-contained JSON file of the run — commit it to a bug report. |
| `orangebox clear [--yes]` | Delete all recorded data. |

| Flag | Default | Behavior |
| --- | --- | --- |
| `--port <n>` | `4100` | Listen port. |
| `--db <path>` | `~/.orangebox/orangebox.db` | Database location; parent dirs are created. |
| `--host <addr>` | `127.0.0.1` | Bind address. Anything non-loopback prints a warning — there is no auth. |
| `--gap <seconds>` | `120` | Idle gap that starts a new implicit run. |
| `--retain <days>` | `0` (forever) | On start, delete runs older than N days. |
| `--no-open` | — | Don't open the browser. |

## Grouping calls into runs

Every call belongs to exactly one run, resolved in this order:

1. **Path-scoped** — traffic through `/r/<run-id>/anthropic/…`. This is what `orangebox run` sets up.
2. **Header** — send `x-orangebox-run-id: <id>`; both SDKs let you set default headers.
3. **Idle gap** — otherwise, calls within `--gap` seconds of each other land in the same run.

The gap heuristic is deliberately simple. Two unrelated agents running at once will interleave into one implicit run; if that matters, use one of the explicit mechanisms above.

## Pricing

Rates live in [`src/pricing.json`](src/pricing.json), matched by the longest key that prefixes the model string — so `claude-haiku-4-5-20251001` resolves through `claude-haiku-4-5`. Prices drift. Drop a corrected file at `~/.orangebox/pricing.json` and orangebox deep-merges it over the shipped one at boot, no upgrade needed:

```json
{ "claude-opus-5": { "in": 5.00, "out": 25.00, "cache_read": 0.50, "cache_write": 6.25 } }
```

## Privacy, plainly

**The database contains your prompts. So do its exports.** That is the whole product — treat both accordingly.

What orangebox does *not* store: API keys. Request headers are reduced to an allowlist (`content-type`, `anthropic-version`, `user-agent`) before anything is written, and any header whose name looks like a credential is dropped regardless. Keys live in process memory only for the duration of the upstream request and never reach the database, the logs, an export, or the UI.

Bind address is `127.0.0.1` by default and there is no authentication, so `--host 0.0.0.0` exposes every recorded prompt to your network. orangebox tells you so, in red, when you do it.

Outbound connections go to `api.anthropic.com` and `api.openai.com` only, and only in direct response to a request you proxied. No version checks, no telemetry, no analytics — not in this version and not in any future one.

## FAQ

**Which providers?** Anthropic Messages and OpenAI Chat Completions today. More are planned — the parser interface is the extension point. Vote in issues.

**Where's my data?** One SQLite file, `~/.orangebox/orangebox.db` (override with `--db`). Delete it and it's gone.

**Does it slow my agent down?** Under 5 ms p50 added latency on a non-streamed call, and effectively zero per chunk on a streamed one — chunks are written through the moment they arrive, and parsing and database writes happen after your client's response has completed.

**Does it work with `<my framework>`?** If it speaks HTTP to one of the two supported APIs, yes. That's the point of doing this at the proxy layer instead of as an SDK wrapper.

**What happens if orangebox breaks?** Recording failures are logged and swallowed; your request still goes through. A recorder that takes down the thing it records is worse than no recorder.

**Why "orangebox"?** Aircraft "black boxes" are painted international orange so they can be found. Same idea: when your agent crashes, the evidence should survive — and be easy to spot.

## Roadmap

- [ ] **Replay** — re-send any recorded call, optionally with an edited prompt or a different model, and diff the outputs
- [ ] **Run diffing** — side-by-side timelines of two runs of the same agent
- [ ] **More providers** — Gemini, Bedrock, Ollama and other local runtimes
- [ ] **OpenTelemetry export** — for teams that already have tracing
- [ ] **Cost dashboard** — spend over time, by model, by run name
- [ ] **Assertions** — fail CI when a run exceeds a cost, latency, or loop-count threshold

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for manual probes and the layout of the codebase. The full build specification this was written from is [`orangebox-spec.html`](orangebox-spec.html).

Requires Node 20 or newer. One runtime dependency: `better-sqlite3`.

```bash
npm install
npm test        # no network access; every upstream is a local mock
```

## License

MIT
