# Changelog

All notable changes to orangebox are documented here. Versions follow semantic versioning.

## Unreleased

### Added

- `orangebox import <file.json>` reads an exported run into the local database (§10.7).
- `orangebox prune` reclaims space by age or size, and `--vacuum` rebuilds the file so deleted pages return to the filesystem.
- Optional config file at `~/.orangebox/config.json` for port, host, db, gap, retention, upstreams, and redaction rules. Flags win over the file; the file wins over defaults.
- User-defined redaction (§12.4): regexes in `redact` scrub sensitive text from recorded prompts and responses before they are written. Affects what is stored, never what is forwarded.
- Keyboard shortcut overlay behind `?`.
- Content search (§19.9) at `/find`, as `orangebox find`, and at `GET /api/search`: searches recorded prompts and responses, returning a snippet around each hit.
- `npm run bench` measures the four §13 performance budgets the README publishes.
- Tool analytics (§19.8) at `/tools` and as `orangebox tools`: uses, error rate, unanswered calls, and timing per tool, with `--json` and `--csv`. Served at `GET /api/tools`.
- `orangebox doctor`: reports the resolved version, database, every routable provider with its upstream and credential status, and pricing coverage against calls actually recorded. Exits non-zero on a failure; `--json` for tooling.
- Integration tests that run the CLI as a real subprocess, covering provider routing, `spend`, `export`, `assert`, and `doctor`. The 1.2.0 provider bug survived a full release because every test built the server in-process, skipping the code that turns flags into configuration.

## [1.2.1] - 2026-08-30

### Added

- Replay credentials for every provider it can route: Gemini (`GEMINI_API_KEY`/`GOOGLE_API_KEY`), Bedrock (`AWS_BEARER_TOKEN_BEDROCK`/`BEDROCK_API_KEY`), and Ollama (none required).
- `--gemini-upstream`, `--ollama-upstream`, and `--bedrock-upstream`.
- Spend rows drill down: clicking one filters the runs list to the calls behind it (model, provider, run, or day).
- Runs can be filtered by provider, in the UI and via `GET /api/runs?provider=`.
- `spend` reports `unrated_calls` and `no_usage_calls` alongside `unpriced_calls`, in the API, the UI, and `--csv`.

### Fixed

- `orangebox run` set base URLs for Anthropic and OpenAI only, so wrapping a Gemini, Ollama or Bedrock agent produced an empty run while reporting that it was recording. All five providers are now pointed at the run-scoped prefix.
- A failure during UI startup rendered "Recorder unavailable" with the underlying error discarded, making it indistinguishable from the server being down. The reason is now logged.

- **Gemini, Ollama and Bedrock were unreachable from the CLI.** They shipped in 1.2.0 routable, parsed, priced and covered by end-to-end tests, but `providersFrom()` named only openai and anthropic, so every real invocation proxied the other three to `undefined/v1/...`. The test suite passed throughout because the harness injects a providers map directly — the one path no user takes. Provider routes are now derived from the upstream table, so nothing can be routable without somewhere to route it.
- Replay sent no credential for Gemini or Bedrock, producing an upstream 401 with no indication that orangebox had simply never learned about those providers. A missing key is now refused up front, naming the variables to set, and before the replay run is created so no orphan run is left behind.
- Browser API errors discarded the server's explanation and reported `400 /api/calls/…/replay`. They now carry the server's own message.
- The spend view blamed every incomplete total on a missing pricing entry and told you to edit `pricing.json`. Calls that errored, were aborted, or streamed without usage have no cost for an unrelated reason, and no edit to that file would have helped. Both causes are now counted and described separately.
- `orangebox assert --require-known-cost` reported only a count; it now names how many calls lack a rate versus how many never reported token counts.

## [1.2.0] - 2026-08-22

### Added

- Cost dashboard (§19.5) at `/spend` and as `orangebox spend`. Groups by model, provider, run, or day; windows by `--days`/`--since`/`--until`; emits `--csv` or `--json`. Unpriced calls are counted and reported alongside every total rather than folded silently into it, so a figure that is too low says so.
- Amazon Bedrock support (§19.3): Converse and ConverseStream, including an AWS event-stream (binary frame) decoder, tool-call reassembly, and cross-region inference-profile pricing.
- Google Gemini and Ollama providers, completing the §19.3 provider list.
- Bedrock pricing entries; cross-region prefixes (`us.`/`eu.`/`apac.`/`global.`) resolve to a single table entry per model.
- Installable responsive PWA shell with phone navigation, safe-area support, and an offline app shell that never caches prompts or API data.
- Preview `--mobile` mode with high-entropy LAN pairing, rate limiting, revocable read-only sessions, and local device management.
- Opt-in browser notifications for completed calls when orangebox is running in a secure browser context.

### Changed

- `spend` grouped by day returns days newest-first rather than ranked by cost; a date list in cost order cannot be read as a trend.
- UI DOM helpers moved from `app.js` into `ui/dom.js`, which now creates SVG elements in the SVG namespace.

### Fixed

- Opening `/spend` directly landed on a run instead: the boot sequence checked the route after `loadRuns()` had already rewritten the URL.
- `j`/`k`/`Enter`/`g` moved the timeline selection while the spend view was open, so closing it landed you on a call you never chose.
- `Store.spend()` guarded its grouping whitelist with a truthiness check, which prototype-chain keys such as `constructor` passed. It now uses `Object.hasOwn`. The HTTP endpoint validates against a `Set` and was never exposed.

### Security

- Mobile credentials are stored as hashed, in-memory sessions and delivered in HttpOnly, `SameSite=Strict` cookies. Paired devices cannot mutate recordings, replay calls, clear data, or proxy provider traffic.

### Known limitations

- Bedrock requires bearer-token auth (a Bedrock API key). SigV4 signs the `Host` header and orangebox strips `Host` like any reverse proxy, so a signed request cannot survive the hop; orangebox will not hold AWS credentials in order to re-sign.
- Bedrock rates are the model owner's on-demand first-party rates. Per-region variation and Provisioned Throughput (billed hourly, not per token) are not represented.
- Mobile LAN transport is currently HTTP. Use the preview only on a trusted private network; local HTTPS and QR onboarding remain planned.

## [1.1.0] - 2026-08-11

First public npm release.

### Added

- OpenAI Responses API capture, including semantic SSE events, function calls and outputs, cached-token usage, and partial streams.
- Live in-flight timeline placeholders with first-token timing before a call is persisted.
- Replay and edit with an automatically opened whole-run comparison.
- Whole-run comparison for prompt, output, tools, model, latency, tokens, cost, and errors.
- Run search, pagination, filters, rename, and tags.
- Sanitized, self-contained HTML sharing previews and OpenTelemetry GenAI JSON export.
- Configurable OpenAI-compatible and Anthropic-compatible upstream URLs.
- `orangebox assert` thresholds for CI cost, latency, errors, call count, and unknown cost.
- Ordered SQLite schema migrations and Windows-specific onboarding commands.

### Security

- Protected destructive APIs with same-origin, JSON content-type, and per-start CSRF checks.
- Required token authentication or an explicit unsafe override for non-loopback binding.
- Bounded request forwarding and response capture memory, with oversized requests spooled to disk.

### Changed

- Unknown run costs are visibly partial instead of appearing to be complete totals.
- Narrow layouts use a responsive runs drawer instead of hiding run navigation.
- Cross-platform CI now tests packed fresh installs on Windows, macOS, and Linux.

## [1.0.0] - 2026-08-10

- Initial GitHub preview: local Anthropic Messages and OpenAI Chat Completions recorder, SQLite store, timeline, call detail, tool pairing, diffing, pricing, and JSON export.

[1.1.0]: https://github.com/EzraStone/orangebox/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/EzraStone/orangebox/releases/tag/v1.0.0
