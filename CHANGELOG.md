# Changelog

All notable changes to orangebox are documented here. Versions follow semantic versioning.

## Unreleased

### Added

- Installable responsive PWA shell with phone navigation, safe-area support, and an offline app shell that never caches prompts or API data.
- Preview `--mobile` mode with high-entropy LAN pairing, rate limiting, revocable read-only sessions, and local device management.
- Opt-in browser notifications for completed calls when orangebox is running in a secure browser context.

### Security

- Mobile credentials are stored as hashed, in-memory sessions and delivered in HttpOnly, `SameSite=Strict` cookies. Paired devices cannot mutate recordings, replay calls, clear data, or proxy provider traffic.

### Known limitations

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
