// §20 — optional configuration file.
//
// orangebox has always been flags-and-environment only, which is right for a
// tool you run with npx. But some settings are properties of a machine rather
// than of an invocation — where the database lives, which port, what to redact
// from recorded prompts — and retyping them on every command is how people end
// up with a shell alias that drifts out of date.
//
// Precedence, highest first: an explicit flag, then this file, then the
// built-in default. A flag always wins, so a config file can never make a
// command do something other than what its arguments say.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function defaultConfigPath() {
  return path.join(os.homedir(), '.orangebox', 'config.json');
}

/** Settings the file is allowed to set, and how to validate each one. */
const FIELDS = {
  port: (v) => (Number.isInteger(v) && v > 0 && v < 65536 ? v : invalid('port', v, 'a port number')),
  host: (v) => (typeof v === 'string' && v !== '' ? v : invalid('host', v, 'a bind address')),
  db: (v) => (typeof v === 'string' && v !== '' ? v : invalid('db', v, 'a path')),
  gap: (v) => (Number.isInteger(v) && v >= 0 ? v : invalid('gap', v, 'seconds')),
  retain: (v) => (Number.isInteger(v) && v >= 0 ? v : invalid('retain', v, 'days')),
  open: (v) => (typeof v === 'boolean' ? v : invalid('open', v, 'true or false')),
  upstreams: (v) => {
    if (!isPlainObject(v)) return invalid('upstreams', v, 'an object of provider: url');
    for (const [provider, url] of Object.entries(v)) {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        return invalid(`upstreams.${provider}`, url, 'an http(s) URL');
      }
    }
    return { ...v };
  },
  redact: (v) => {
    if (!Array.isArray(v)) return invalid('redact', v, 'an array of rules');
    return v.map((rule, i) => normaliseRedactionRule(rule, i));
  }
};

class ConfigError extends Error {}

function invalid(field, value, expected) {
  throw new ConfigError(`config: "${field}" must be ${expected}, got ${JSON.stringify(value)}`);
}

function normaliseRedactionRule(rule, index) {
  if (typeof rule === 'string') return { pattern: rule, replacement: '[redacted]', flags: 'g' };
  if (!isPlainObject(rule)) return invalid(`redact[${index}]`, rule, 'a string or an object');
  if (typeof rule.pattern !== 'string' || rule.pattern === '') {
    return invalid(`redact[${index}].pattern`, rule.pattern, 'a regular expression');
  }
  return {
    pattern: rule.pattern,
    replacement: typeof rule.replacement === 'string' ? rule.replacement : '[redacted]',
    // 'g' is always on: a rule that only scrubs the first occurrence of a
    // secret in a prompt has not scrubbed the secret.
    flags: `g${typeof rule.flags === 'string' ? rule.flags.replace(/[^imsu]/g, '') : ''}`,
    label: typeof rule.label === 'string' ? rule.label : undefined
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Read and validate the config file.
 *
 * Returns { config, path, errors }. A malformed file is reported, not thrown
 * past — orangebox starting with defaults and a loud warning is better than
 * orangebox refusing to start because of a stray comma in a file the user may
 * not remember writing. An unknown key is reported too, since a typo'd setting
 * that silently does nothing is the worst outcome of the three.
 */
export function loadConfig({ file = defaultConfigPath(), fs: fileSystem = fs } = {}) {
  let raw;
  try {
    raw = fileSystem.readFileSync(file, 'utf8');
  } catch {
    return { config: {}, path: file, present: false, errors: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      config: {},
      path: file,
      present: true,
      errors: [`config: ${file} is not valid JSON (${error.message})`]
    };
  }

  if (!isPlainObject(parsed)) {
    return { config: {}, path: file, present: true, errors: [`config: ${file} must contain a JSON object`] };
  }

  const config = {};
  const errors = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('_')) continue; // comments
    if (!Object.hasOwn(FIELDS, key)) {
      errors.push(`config: unknown setting "${key}" — ignored`);
      continue;
    }
    try {
      config[key] = FIELDS[key](value);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      errors.push(error.message);
    }
  }

  return { config, path: file, present: true, errors };
}

/**
 * Merge in precedence order: an explicit flag beats the file, which beats the
 * built-in default. `flags` carries only values the user actually typed, so
 * `undefined` means "not specified" rather than "off".
 */
export function resolveSettings({ flags = {}, config = {}, defaults = {} } = {}) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) out[key] = value;
  }
  for (const [key, value] of Object.entries(flags)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Turn validated rules into compiled regexes, dropping any that will not compile. */
export function compileRedactionRules(rules = []) {
  const compiled = [];
  const errors = [];

  for (const rule of rules) {
    try {
      compiled.push({
        regex: new RegExp(rule.pattern, rule.flags ?? 'g'),
        replacement: rule.replacement ?? '[redacted]',
        label: rule.label ?? rule.pattern
      });
    } catch (error) {
      errors.push(`config: redaction pattern ${JSON.stringify(rule.pattern)} is not a valid regular expression (${error.message})`);
    }
  }

  return { rules: compiled, errors };
}
