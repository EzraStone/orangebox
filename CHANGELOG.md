# Changelog

All notable changes to orangebox are documented here. Versions follow semantic versioning.

## Unreleased

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
