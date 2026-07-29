<p align="center">
  <img src="docs/img/plate.svg" width="900" alt="orangebox — flight data recorder for the agent you're building. Local proxy plus UI, Node 20 or newer, one dependency, no telemetry, MIT licensed.">
</p>

<p align="center">
  <a href="https://ezrastone.github.io/orangebox-Website/"><b>Website</b></a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#who-this-is-for">Who it's for</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="orangebox-spec.html">Build spec</a>
</p>

<p align="center">
  <a href="https://github.com/EzraStone/orangebox/actions/workflows/ci.yml"><img src="https://github.com/EzraStone/orangebox/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020-3FB868" alt="Node 20 or newer">
  <img src="https://img.shields.io/badge/dependencies-1-E8490F" alt="One runtime dependency">
  <img src="https://img.shields.io/badge/telemetry-none-2E5490" alt="No telemetry">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

Point your agent at a local port and press play. orangebox records every LLM API call **your own agent code** makes — the exact prompt, the tool calls, the stream, the retries, the tokens, the cost — into one SQLite file on your machine, and draws each run as a timeline you can inspect, diff, and export.

*Aircraft black boxes are painted international orange so they can be found. Same idea: when your agent crashes, the evidence should survive.*

<!-- The figures below are drawn to scale from real recorded runs. A screen-capture
     GIF (§18.1: ~1280x720, under 15 MB, loop under 25 s) would still be better
     above the fold and is the one launch asset not yet made. -->

<p align="center">
  <img src="docs/img/timeline.svg" width="900" alt="The orangebox UI: a runs list on the left, and a timeline of three calls — a planning call, a tool-loop call with two tool chips and a 2.1 second client-side gap, and a streaming call with a time-to-first-token of 108 milliseconds.">
</p>

---

## Quickstart

Needs **Node 20 or newer**. Nothing to sign up for, nothing to configure.

```bash
npx -y github:EzraStone/orangebox
```

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:4100/anthropic"   # then run your agent
```

That's it. The UI opens at <http://127.0.0.1:4100> and fills in as your agent runs.

Prefer not to touch environment variables? Let orangebox set them for you, and get precise run boundaries for free:

```bash
npx -y github:EzraStone/orangebox run --name "checkout bot" -- node agent.js
```

> **Not on npm yet.** That is why the commands read `github:EzraStone/orangebox` rather than the shorter `npx orangebox`. Installing from GitHub works today; once the package is published, the short form will work too and these will keep working.

### No API key? See it working anyway

```bash
git clone https://github.com/EzraStone/orangebox && cd orangebox && npm install
node examples/demo-offline.mjs
```

That starts a fake provider on loopback, points orangebox at it, seeds two realistic runs — a plan → tool-loop → streamed-synthesis run and a retry storm — then stays up so you can explore the UI and curl the proxy yourself. No API key, no network, and a throwaway database that never touches `~/.orangebox`.

The fake provider reacts to the model name, so you can exercise the failure paths on demand: `claude-opus-5-429`, `-500`, `-slow`, `-die`.

## Who this is for

**orangebox records the agent you are building, not the agent CLI you are using.**

If you are writing agent code yourself — against the Anthropic or OpenAI SDK, or on top of a framework like LangGraph — orangebox records that traffic. It sits at the HTTP layer, so it does not care which client library, language, or framework you chose, and there is nothing for it to fall behind on when you switch.

If instead you want to inspect what an off-the-shelf coding-agent CLI is doing — Claude Code, Codex CLI, Gemini CLI, Cursor CLI and friends — a tool purpose-built for those, like [claude-tap](https://github.com/liaohch3/claude-tap), is the better fit: it knows those specific tools, auto-detects their auth, and needs no configuration at all. orangebox is deliberately not competing for that job.

Same mechanism, different target. Pick the one aimed at your problem.

## Why

- **Zero code changes.** One environment variable, or none at all with `orangebox run`. Nothing to instrument, nothing to forget.
- **Fully local. No account, no telemetry, no cloud.** Your prompts go into one SQLite file on your machine and nowhere else. The process makes no network calls except forwarding yours upstream.
- **Works with any language or framework.** It's just HTTP — Python, JS, Go, curl, LangChain, whatever. orangebox sits at the wire, so it cannot be bypassed by a client library it has never heard of.

## What you get

**A timeline of the whole run.** Every call in order, with latency, token counts, stop reason, and estimated cost. A 40-second tool gap or a 3× retry storm is visible without reading anything.

**The exact prompt the model saw.** Click any call and read the full message history at that moment — system prompt, every turn, tool results injected — as the model received it, not as you think you assembled it.

**Tool calls, paired.** `tool_use` blocks and the `tool_result` that answered them, linked, with errors flagged. The wall-clock gap between calls is labelled "client-side ≈" because orangebox sees the result, not the execution.

**Diffing, because prompts drift.** Any call can be diffed against another — the previous call in the run by default, or any call in any other run. Line-level, with long unchanged stretches collapsed, so "what changed in the prompt between turn 4 and turn 5?" is one click instead of an eyeball comparison of two 6,000-line payloads. Works on the request or the response.

<p align="center">
  <img src="docs/img/diff.svg" width="900" alt="The Diff tab comparing call 03 against call 02: pickers for the baseline run and call, a request/response toggle, and a unified diff showing 44 added lines with 36 unchanged lines collapsed.">
</p>

**Streaming, faithfully.** Chunks are relayed the instant they arrive — the recorder adds no measurable latency — then the captured transcript is folded back into a normal response object so a streamed call reads exactly like a non-streamed one. Time-to-first-token is recorded per call.

**Cost, labelled honestly.** Token counts × the rates in `src/pricing.json`. Always shown as "est.", never as billing truth. Unpriced model or missing counts? You get an em-dash and a tooltip saying which, not a confident $0.00.

<!-- §18.1 asks for one screenshot per feature. The figures above cover the
     timeline, the detail drawer, and the diff; real screen captures should
     replace them once there is a run worth photographing. -->

## How it works

<p align="center">
  <img src="docs/img/architecture.svg" width="900" alt="Your agent points its base URL at orangebox. One Node process proxies bytes unmodified to the provider while teeing a copy through a parser into SQLite, and serves the JSON API, live SSE feed, and UI to your browser.">
</p>

One process, one port. Requests are proxied through untouched and teed to a parser that writes a normalized record to `~/.orangebox/orangebox.db`. The same port serves the UI, a JSON API, and a live SSE feed so the timeline updates while your agent is still running.

Recording happens **after** your client's response is finished — never in the hot path. Measured against a local mock, on one machine:

| Metric | Measured | Budget |
| --- | --- | --- |
| Added latency, non-streamed call | 0.73 ms p50 | < 5 ms |
| 50 concurrent streams, event-loop lag | 31 ms max | < 50 ms |
| Request → recorded | 3 ms p50 | < 150 ms |
| UI open, 1000-call run | 11 ms | < 500 ms |

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

**How is this different from claude-tap?** Different target, same good idea. [claude-tap](https://github.com/liaohch3/claude-tap) records off-the-shelf coding-agent CLIs and knows how each one authenticates; orangebox records agent code you wrote yourself and knows nothing about your stack beyond the two HTTP APIs. If you want to see inside Claude Code, use claude-tap. If you want to see inside the thing you are building, use this. See [Who this is for](#who-this-is-for).

**Why not just use Langfuse / Helicone / LiteLLM?** Those are built for teams running agents in production — dashboards, evals, prompt versioning, multi-provider routing, and an account. orangebox is for one developer debugging on one machine, with no account and no data leaving it. Different job; graduate to one of those when you need it.

**What happens if orangebox breaks?** Recording failures are logged and swallowed; your request still goes through. A recorder that takes down the thing it records is worse than no recorder.

**Why "orangebox"?** Aircraft "black boxes" are painted international orange so they can be found. Same idea: when your agent crashes, the evidence should survive — and be easy to spot.

## Roadmap

- [x] **Call diffing** — compare any two calls, in the same run or across runs
- [ ] **Replay** — re-send any recorded call, optionally with an edited prompt or a different model, and diff the outputs
- [ ] **Run diffing** — side-by-side timelines of two whole runs, aligned call by call
- [ ] **More providers** — Gemini, Bedrock, Ollama and other local runtimes
- [ ] **OpenTelemetry export** — for teams that already have tracing
- [ ] **Cost dashboard** — spend over time, by model, by run name
- [ ] **Assertions** — fail CI when a run exceeds a cost, latency, or loop-count threshold

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for manual probes and the layout of the codebase. The full build specification this was written from is [`orangebox-spec.html`](orangebox-spec.html), also published [on the website](https://ezrastone.github.io/orangebox-Website/spec.html).

The landing page lives in its own repo: [EzraStone/orangebox-Website](https://github.com/EzraStone/orangebox-Website).

Requires Node 20 or newer. One runtime dependency: `better-sqlite3`.

```bash
npm install
npm test        # no network access; every upstream is a local mock
```

## License

MIT
