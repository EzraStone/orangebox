// `orangebox doctor` — answer "is this thing set up the way I think it is?"
//
// Written after Gemini, Ollama and Bedrock shipped routable, parsed, priced,
// and pointed at `undefined`. Nothing in the product would have told you: the
// banner listed two environment variables, the UI looked fine, and the failure
// only appeared as a mangled URL inside an error body. A command that prints
// what orangebox actually resolved would have shown it immediately.
//
// Every check returns data, not text. The CLI decides how to draw it, and a
// test can assert on the outcome without parsing output.

import { PROVIDER_CREDENTIALS, resolveCredential } from './credentials.mjs';

/** Check outcomes, in increasing order of "you should look at this". */
export const OK = 'ok';
export const NOTE = 'note';
export const WARN = 'warn';
export const FAIL = 'fail';

const RANK = { [OK]: 0, [NOTE]: 1, [WARN]: 2, [FAIL]: 3 };

/** The worst outcome in a list — what the command's exit code keys off. */
export function worst(checks) {
  return checks.reduce((acc, check) => (RANK[check.status] > RANK[acc] ? check.status : acc), OK);
}

/**
 * Every provider: where its traffic goes, and whether a replay of it could
 * authenticate. Credential *values* are never read into the result — only the
 * name of the variable that supplied one.
 */
export function checkProviders(providers, { env = process.env, routable } = {}) {
  // Iterate what the router will accept, not what happens to be configured.
  // A provider missing from the map is the failure worth reporting, and it
  // reports as absence — which is the one thing nobody notices in a list.
  const names = routable ?? Object.keys(providers);

  return names.map((provider) => {
    const upstream = Object.hasOwn(providers, provider) ? providers[provider] : undefined;
    const known = Object.hasOwn(PROVIDER_CREDENTIALS, provider);

    // The exact shape of the shipped bug: routable, but with nothing to route
    // to. Worth failing loudly rather than noting.
    if (typeof upstream !== 'string' || upstream === '') {
      return {
        name: `provider ${provider}`,
        status: FAIL,
        detail: 'routable but has no upstream — requests to it cannot be proxied at all',
        provider
      };
    }

    let host;
    try {
      host = new URL(upstream).host;
    } catch {
      return {
        name: `provider ${provider}`,
        status: FAIL,
        detail: `upstream is not a URL: ${upstream}`,
        provider
      };
    }

    if (!known) {
      return {
        name: `provider ${provider}`,
        status: NOTE,
        detail: `${host} — no credential mapping, so replay cannot authenticate it`,
        provider
      };
    }

    const credential = resolveCredential(provider, env);
    if (!credential.required) {
      return { name: `provider ${provider}`, status: OK, detail: `${host} — no key needed`, provider };
    }
    if (credential.ok) {
      return {
        name: `provider ${provider}`,
        status: OK,
        detail: `${host} — key from ${credential.source}`,
        provider
      };
    }
    return {
      name: `provider ${provider}`,
      status: NOTE,
      detail: `${host} — recording works; replay needs ${credential.checked.join(' or ')}`,
      provider
    };
  });
}

/** Runtime facts worth knowing before anything else is believed. */
export function checkRuntime({ version, nodeVersion = process.version, platform = process.platform } = {}) {
  const checks = [{ name: 'orangebox', status: OK, detail: `v${version} on ${platform}` }];

  const major = Number(String(nodeVersion).replace(/^v/, '').split('.')[0]);
  checks.push(
    Number.isFinite(major) && major >= 20
      ? { name: 'node', status: OK, detail: nodeVersion }
      : {
          name: 'node',
          status: FAIL,
          detail: `${nodeVersion} — orangebox needs Node 20 or newer`
        }
  );

  return checks;
}

/**
 * The database: reachable, and how much of your prompt history is in it.
 * Size matters enough to say out loud — this file holds every prompt recorded.
 */
export function checkDatabase(store, { largeBytes = 500 * 1024 * 1024 } = {}) {
  try {
    const runs = store.countRuns();
    const bytes = store.sizeBytes();
    const schema = store.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();

    const checks = [
      {
        name: 'database',
        status: OK,
        detail: `${store.path} — ${runs} run(s), ${formatBytes(bytes)}, schema v${schema?.value ?? '?'}`
      }
    ];

    if (bytes > largeBytes) {
      checks.push({
        name: 'database size',
        status: NOTE,
        detail: `${formatBytes(bytes)} of recorded prompts. --retain <days> prunes old runs.`
      });
    }
    return checks;
  } catch (error) {
    return [{ name: 'database', status: FAIL, detail: String(error?.message ?? error) }];
  }
}

/**
 * Pricing coverage, measured against what is actually recorded rather than
 * against the table — a table full of models you never call proves nothing.
 */
export function checkPricing(store, pricing) {
  const checks = [
    {
      name: 'pricing table',
      status: OK,
      detail: `${pricing.entries.length} model rates${pricing.meta.userFileLoaded ? ', plus your ~/.orangebox/pricing.json' : ''}`
    }
  ];

  try {
    const spend = store.spend({ groupBy: 'model' });
    if (spend.total_calls === 0) return checks;

    if (spend.unrated_calls > 0) {
      const unrated = spend.groups
        .filter((g) => g.unrated_calls > 0)
        .map((g) => g.key)
        .slice(0, 5);
      checks.push({
        name: 'unpriced models',
        status: NOTE,
        detail: `${spend.unrated_calls} recorded call(s) have no rate: ${unrated.join(', ')}`
      });
    }
    if (spend.no_usage_calls > 0) {
      checks.push({
        name: 'calls without usage',
        status: NOTE,
        detail: `${spend.no_usage_calls} call(s) reported no token counts, so their cost is unknowable`
      });
    }
  } catch {
    // A spend query failing is not a reason for doctor itself to fall over.
  }

  return checks;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
