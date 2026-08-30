// §19.7 — where replay gets a key from.
//
// orangebox never stores credentials (§12.2): headers are reduced to an
// allowlist before anything is written, and anything that looks like a secret
// is dropped regardless. That is the right call, and it has a consequence —
// replaying a recorded call cannot recover the key that call was made with, so
// it has to be told one.
//
// The environment is the whole mechanism. Nothing here reads or writes a file,
// and no value from this module is ever persisted or returned to a browser;
// only the *names* of the variables are, which is what makes it safe to show
// someone what they need to set.

/**
 * Per provider: which environment variables can supply the credential, and how
 * it goes on the wire. `env` is ordered — the first one set wins — so a
 * provider-specific name beats a general one.
 */
export const PROVIDER_CREDENTIALS = {
  anthropic: {
    env: ['ANTHROPIC_API_KEY'],
    header: 'x-api-key',
    format: (key) => key,
    extra: () => ({ 'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01' })
  },
  openai: {
    env: ['OPENAI_API_KEY'],
    header: 'authorization',
    format: (key) => `Bearer ${key}`
  },
  gemini: {
    // Google's own tooling reads either, GEMINI_API_KEY taking precedence.
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    header: 'x-goog-api-key',
    format: (key) => key
  },
  bedrock: {
    // A Bedrock API key, not SigV4 — orangebox strips Host like any reverse
    // proxy, and SigV4 signs Host, so a signed request cannot survive the hop.
    env: ['AWS_BEARER_TOKEN_BEDROCK', 'BEDROCK_API_KEY'],
    header: 'authorization',
    format: (key) => `Bearer ${key}`
  },
  ollama: {
    // Local inference. There is nothing to authenticate against, and demanding
    // a key here would break replay for the one provider that never needs one.
    env: [],
    header: null,
    format: null
  }
};

/**
 * Resolve a provider's credential from the environment.
 *
 * Returns { ok, headers, provider, required, checked, source }. `ok` is false
 * only when the provider needs a key and none of its variables are set —
 * callers should refuse rather than send an unauthenticated request, because
 * the upstream's 401 arrives with no hint about which variable was missing.
 *
 * The resolved secret appears only in `headers`. `checked` and `source` carry
 * variable names, never values, so they are safe to log or show in a UI.
 */
export function resolveCredential(provider, env = process.env) {
  const spec = PROVIDER_CREDENTIALS[Object.hasOwn(PROVIDER_CREDENTIALS, provider) ? provider : ''];

  if (!spec) {
    return { ok: false, provider, required: false, checked: [], source: null, headers: {}, unknown: true };
  }

  const extra = typeof spec.extra === 'function' ? spec.extra() : {};

  // No credential needed at all.
  if (spec.env.length === 0) {
    return { ok: true, provider, required: false, checked: [], source: null, headers: { ...extra } };
  }

  for (const name of spec.env) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      return {
        ok: true,
        provider,
        required: true,
        checked: [...spec.env],
        source: name,
        headers: { ...extra, [spec.header]: spec.format(value.trim()) }
      };
    }
  }

  return {
    ok: false,
    provider,
    required: true,
    checked: [...spec.env],
    source: null,
    headers: { ...extra }
  };
}

/**
 * Should a missing credential block the replay?
 *
 * Only when the provider is still pointed at the endpoint orangebox ships.
 * If someone has overridden the upstream — a local vLLM, LiteLLM, an internal
 * gateway — they configured that endpoint and know what it wants. Refusing
 * there would break replay for a setup that needs no key at all, and
 * orangebox is in no position to guess which it is.
 */
export function credentialRequired(provider, configuredUpstream, defaults) {
  if (!Object.hasOwn(PROVIDER_CREDENTIALS, provider)) return false;
  if (PROVIDER_CREDENTIALS[provider].env.length === 0) return false;
  const shipped = defaults && Object.hasOwn(defaults, provider) ? defaults[provider] : undefined;
  if (!shipped || !configuredUpstream) return false;
  return configuredUpstream === shipped;
}

/** A sentence naming what to set. Variable names only — never a value. */
export function missingCredentialMessage(result) {
  if (!result || result.ok) return null;
  if (result.unknown) return `no credential mapping for provider "${result.provider}"`;
  const names = result.checked;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
  return `replaying this ${result.provider} call needs a key: set ${list} in the environment orangebox runs in, then restart it. orangebox does not store credentials, so it cannot recover the one the original call used.`;
}
