// §08 — token accounting. Rates live in pricing.json (USD per million tokens);
// a user file at ~/.orangebox/pricing.json is deep-merged over the shipped one
// so nobody has to wait for a release when a provider changes prices.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED = path.join(HERE, 'pricing.json');

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

  return new Pricing(entries, { userFileLoaded: Boolean(user) });
}

export class Pricing {
  constructor(entries, meta = {}) {
    this.entries = entries;
    this.meta = meta;
  }

  /** Longest key that is a prefix of the model string wins. */
  rateFor(model) {
    if (typeof model !== 'string' || model === '') return null;
    for (const [key, rate] of this.entries) {
      if (model.startsWith(key)) return rate;
    }
    return null;
  }

  /**
   * Estimated USD for one call. Returns null when the model is unpriced, or
   * when every token field is null — an unknown count is not the same as zero,
   * and a confidently-wrong $0.00 is worse than an em-dash (§08).
   */
  costFor({ model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens }) {
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
