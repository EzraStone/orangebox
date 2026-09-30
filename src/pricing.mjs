// §08 — token accounting. Rates live in pricing.json (USD per million tokens);
// a user file at ~/.orangebox/pricing.json is deep-merged over the shipped one
// so nobody has to wait for a release when a provider changes prices.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED = path.join(HERE, 'pricing.json');

/** Providers that run on your own hardware, where per-token cost is zero. */
export const LOCAL_PROVIDERS = new Set(['ollama']);

export function userPricingPath() {
  return path.join(os.homedir(), '.orangebox', 'pricing.json');
}

export function loadPricing({ userFile = userPricingPath() } = {}) {
  const shipped = readJson(SHIPPED) ?? {};
  const user = readJson(userFile);
  const table = user ? deepMerge(shipped, user) : shipped;

  // Keys starting with '_' are documentation, not models.
  const entries = Object.entries(table).filter(([key]) => !key.startsWith('_'));
  // Longest key first so prefix matching is a plain linear scan (§08).
  entries.sort((a, b) => b[0].length - a[0].length);

  // The shipped table's date, not the merged one's: a user file overrides
  // some rates, and says nothing about how current the rest are.
  const updated = typeof shipped._updated === 'string' ? shipped._updated : null;
  return new Pricing(entries, { userFileLoaded: Boolean(user), updated });
}

export class Pricing {
  constructor(entries, meta = {}) {
    this.entries = entries;
    this.meta = meta;
  }

  /**
   * Longest key that is a prefix of the model string wins.
   *
   * Bedrock ids are the model id behind an inference profile, so the same model
   * arrives as `us.anthropic.claude-sonnet-4-5-...`, `eu.anthropic....` and
   * `apac.anthropic....`. Stripping that routing prefix before matching keeps
   * one table entry per model instead of one per region. The recorded model
   * string keeps the prefix — §7.1 stores what the wire said.
   */
  rateFor(model) {
    if (typeof model !== 'string' || model === '') return null;
    for (const candidate of [model, model.replace(/^(us|eu|apac|global)\./, '')]) {
      for (const [key, rate] of this.entries) {
        if (candidate.startsWith(key)) return rate;
      }
    }
    return null;
  }

  /**
   * Estimated USD for one call. Returns null when the model is unpriced, or
   * when every token field is null — an unknown count is not the same as zero,
   * and a confidently-wrong $0.00 is worse than an em-dash (§08).
   */
  costFor({ provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens }) {
    // Local inference has no per-token bill. Reporting an em-dash here would
    // say "orangebox does not know", which is the wrong answer — it does know,
    // and the answer is nothing. Electricity is real but it is not per-token
    // and orangebox has no business guessing at it.
    if (LOCAL_PROVIDERS.has(provider)) return 0;

    const rate = this.rateFor(model);
    if (!rate) return null;

    const counts = [input_tokens, output_tokens, cache_read_tokens, cache_write_tokens];
    if (counts.every((n) => n === null || n === undefined)) return null;

    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const r = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

    const cost =
      (n(input_tokens) / 1e6) * r(rate.in) +
      (n(output_tokens) / 1e6) * r(rate.out) +
      (n(cache_read_tokens) / 1e6) * r(rate.cache_read) +
      (n(cache_write_tokens) / 1e6) * r(rate.cache_write);

    // Sub-nano-dollar noise is not information; round to a tenth of a cent's cent.
    return Math.round(cost * 1e8) / 1e8;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // A missing user file is the normal case; a malformed one should not stop
    // recording, so both degrade to "no override".
    return null;
  }
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] =
      isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * §28 — what prompt caching did to the bill.
 *
 * Reads are a saving: those tokens would otherwise have been charged at the
 * full input rate. Writes are a cost on most providers — 1.25x input — paid
 * once in the hope of reads later. Reporting only the saving would make every
 * cache look free, which is exactly the claim somebody would check.
 *
 * Models with no rate are counted separately rather than assumed free, the
 * same rule the rest of §08 follows: an unknown is not a zero.
 */
export function cacheSavings(rows, pricing) {
  let cachedTokens = 0;
  let writtenTokens = 0;
  let saved = 0;
  let writeCost = 0;
  let unratedCalls = 0;

  for (const row of rows) {
    const read = row.cache_read_tokens ?? 0;
    const written = row.cache_write_tokens ?? 0;
    if (read === 0 && written === 0) continue;

    const rate = pricing.rateFor(row.model);
    if (!rate || typeof rate.in !== 'number') {
      unratedCalls += row.calls ?? 0;
      continue;
    }

    cachedTokens += read;
    writtenTokens += written;
    saved += (read / 1e6) * (rate.in - (rate.cache_read ?? rate.in));
    writeCost += (written / 1e6) * ((rate.cache_write ?? rate.in) - rate.in);
  }

  const round = (v) => Math.round(v * 1e8) / 1e8;
  return {
    cached_tokens: cachedTokens,
    written_tokens: writtenTokens,
    saved_usd: round(saved),
    write_premium_usd: round(writeCost),
    net_usd: round(saved - writeCost),
    unrated_calls: unratedCalls
  };
}
