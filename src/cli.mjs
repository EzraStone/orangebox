// §05 — command-line interface. Hand-rolled arg parsing; the dependency budget
// is one package and better-sqlite3 already spent it.
import { spawn } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';

import { createServer, VERSION, PROVIDERS, ROUTABLE_PROVIDERS } from './server.mjs';
import { defaultDbPath } from './store.mjs';
import { evaluateRunAssertions } from './assertions.mjs';

/** Past this the database is worth mentioning at startup — it is all prompts. */
const LARGE_DB_BYTES = 500 * 1024 * 1024;

const DEFAULTS = {
  port: 4100,
  host: '127.0.0.1',
  db: null, // resolved to defaultDbPath() at start
  gap: 120,
  open: true,
  retain: 0,
  openaiUpstream: 'https://api.openai.com',
  anthropicUpstream: 'https://api.anthropic.com',
  authToken: null,
  unsafeNoAuth: false,
  mobile: false
};

export async function main(argv) {
  const [command, rest] = splitCommand(argv);

  switch (command) {
    case 'help':
      return void printHelp();
    case 'version':
      return void console.log(VERSION);
    case 'start':
      return start(parseFlags(rest));
    case 'run':
      return runWrapped(rest);
    case 'export':
      return exportRun(rest);
    case 'import':
      return importFile(rest);
    case 'prune':
      return prune(rest);
    case 'find':
      return findCalls(rest);
    case 'tools':
      return toolReport(rest);
    case 'doctor':
      return doctor(rest);
    case 'spend':
      return spendReport(rest);
    case 'assert':
      return assertRun(rest);
    case 'clear':
      return clear(rest);
    default:
      console.error(`orangebox: unknown command "${command}"\n`);
      printHelp();
      process.exitCode = 1;
  }
}

/** The default command is `start`, so `npx orangebox --port 5000` works. */
function splitCommand(argv) {
  const first = argv[0];
  if (first === '--help' || first === '-h') return ['help', []];
  if (first === '--version' || first === '-v') return ['version', []];
  if (first && !first.startsWith('-')) return [first, argv.slice(1)];
  return ['start', argv];
}

function parseFlags(args) {
  // Which settings the user actually typed. parseFlags starts from DEFAULTS,
  // so without this there is no way to tell "--port 4100" from "not given" —
  // and the config file would be unable to change anything with a default.
  const explicit = new Set();
  const out = { ...DEFAULTS };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => {
      const v = args[++i];
      if (v === undefined) fail(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--port': out.port = int(next(), '--port'); explicit.add('port'); break;
      case '--host': out.host = next(); explicit.add('host'); break;
      case '--db': out.db = next(); explicit.add('db'); break;
      case '--gap': out.gap = int(next(), '--gap'); explicit.add('gap'); break;
      case '--retain': out.retain = int(next(), '--retain'); explicit.add('retain'); break;
      case '--openai-upstream': out.openaiUpstream = next(); explicit.add('openaiUpstream'); break;
      case '--anthropic-upstream': out.anthropicUpstream = next(); explicit.add('anthropicUpstream'); break;
      case '--gemini-upstream': out.geminiUpstream = next(); explicit.add('geminiUpstream'); break;
      case '--ollama-upstream': out.ollamaUpstream = next(); explicit.add('ollamaUpstream'); break;
      case '--bedrock-upstream': out.bedrockUpstream = next(); explicit.add('bedrockUpstream'); break;
      case '--auth-token': out.authToken = next(); explicit.add('authToken'); break;
      case '--mobile': out.mobile = true; explicit.add('mobile'); break;
      case '--unsafe-no-auth': out.unsafeNoAuth = true; explicit.add('unsafeNoAuth'); break;
      case '--no-open': out.open = false; explicit.add('open'); break;
      case '--help': case '-h': printHelp(); process.exit(0);
      default: fail(`unknown flag "${arg}"`);
    }
  }
  if (out.mobile && out.host === DEFAULTS.host) out.host = '0.0.0.0';
  out.explicit = explicit;
  return out;
}

/**
 * Fold ~/.orangebox/config.json into the parsed flags.
 *
 * Only settings the user did not type are taken from the file, so a flag
 * always wins. Problems with the file are printed rather than thrown: a
 * typo in a config file should not stop the recorder starting.
 */
async function applyConfig(opts) {
  const { loadConfig, compileRedactionRules } = await import('./config.mjs');
  const { config, path: file, present, errors } = loadConfig();

  for (const message of errors) console.error(warn(`  ${message}`));

  const take = (key, flagKey = key) => {
    if (config[key] !== undefined && !opts.explicit.has(flagKey)) opts[flagKey] = config[key];
  };
  take('port');
  take('host');
  take('db');
  take('gap');
  take('retain');
  take('open');

  if (config.upstreams) {
    for (const [provider, url] of Object.entries(config.upstreams)) {
      const flagKey = `${provider}Upstream`;
      if (!opts.explicit.has(flagKey)) opts[flagKey] = url;
    }
  }

  const { rules, errors: ruleErrors } = compileRedactionRules(config.redact ?? []);
  for (const message of ruleErrors) console.error(warn(`  ${message}`));

  return { opts, redactionRules: rules, configPath: present ? file : null };
}
// ------------------------------------------------------------------ start

async function start(rawOpts) {
  const { opts, redactionRules, configPath } = await applyConfig(rawOpts);
  requireRemoteSafety(opts);
  const dbPath = opts.db ?? defaultDbPath();
  let app;
  try {
    app = createServer({
      dbPath,
      gapSeconds: opts.gap,
      providers: providersFrom(opts),
      authToken: opts.authToken,
      mobileAccess: opts.mobile,
      redactionRules
    });
  } catch (err) {
    fail(err.message);
  }

  if (opts.retain > 0) {
    const removed = app.store.retain(opts.retain);
    if (removed > 0) console.log(`  ▮ retention     removed ${removed} run(s) older than ${opts.retain}d`);
  }

  try {
    await app.listen(opts.port, opts.host);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      fail(`port ${opts.port} is already in use — try: orangebox --port ${opts.port + 1}`);
    }
    fail(err.message);
  }

  const origin = `http://${displayHost(opts.host)}:${opts.port}`;
  banner({ origin, store: app.store, host: opts.host, port: opts.port, willOpen: opts.open, authToken: opts.authToken, mobile: app.mobile, configPath, redactionCount: redactionRules.length });

  if (opts.open) openBrowser(opts.authToken ? `${origin}?token=${encodeURIComponent(opts.authToken)}` : origin);

  const shutdown = () => {
    app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return app;
}

function banner({ origin, store, host, port, willOpen, authToken, mobile, configPath = null, redactionCount = 0 }) {
  const size = store.sizeBytes();
  const runs = store.countRuns();
  console.log('');
  console.log(`  ▮ orangebox v${VERSION} — flight recorder for AI agents`);
  console.log(`  ▮ recording on   ${origin}`);
  console.log(`  ▮ database       ${store.path}  (${runs} run${runs === 1 ? '' : 's'}, ${formatBytes(size)})`);
  console.log('  ▮ easiest start   orangebox run --name "my agent" -- node agent.js');
  console.log('  ▮ or point an existing process at it:');
  for (const line of environmentCommands(origin)) console.log(`  ▮   ${line}`);
  console.log(`  ▮ ui             ${origin}${willOpen ? '  (opening browser…)' : ''}`);
  if (authToken) console.log('  ▮ authentication x-orangebox-auth is required');
  // Both of these change what ends up recorded, so running with them
  // silently would be the wrong kind of quiet.
  if (configPath) console.log(`  ▮ config         ${configPath}`);
  if (redactionCount > 0) {
    console.log(`  ▮ redaction      ${redactionCount} rule${redactionCount === 1 ? '' : 's'} applied to recorded prompts`);
  }
  if (mobile?.enabled) {
    const mobileOrigin = lanOrigin(port);
    console.log(`  ▮ mobile         ${mobileOrigin}`);
    console.log(`  ▮ pair link      ${mobileOrigin}/#pair=${mobile.pairingCode}`);
    console.log('  ▮ mobile access  read-only, same network, resets when orangebox restarts');
  }
  console.log('');

  // The database grows forever unless --retain says otherwise, and it is full
  // of prompts. Nobody checks a file they were never told about, so say
  // something once it is big enough to be worth knowing about.
  if (size > LARGE_DB_BYTES) {
    console.error(
      `\x1b[33mNOTE: this database is ${formatBytes(size)} and holds every prompt you have recorded.\x1b[0m\n` +
      `      Trim it with  --retain <days>  on start, or  orangebox clear  to empty it.\n`
    );
  }

  if (!isLoopback(host) && !authToken && !mobile?.enabled) {
    console.error(
      `\x1b[31mWARNING: orangebox has no authentication. Binding to ${host} exposes every recorded prompt to your network.\x1b[0m\n`
    );
  }
}

// ------------------------------------------------------------------- run

/**
 * §05.2 — `orangebox run --name "checkout bot" -- node agent.js`.
 * Wraps a command in an explicit run so its calls group precisely instead of
 * relying on the idle-gap heuristic. The child's exit code becomes ours.
 */
async function runWrapped(args) {
  const separator = args.indexOf('--');
  if (separator === -1 || separator === args.length - 1) {
    fail('usage: orangebox run [--name "..."] -- <command> [args...]');
  }

  const flags = args.slice(0, separator);
  const [command, ...commandArgs] = args.slice(separator + 1);

  const opts = { ...DEFAULTS, name: null };
  for (let i = 0; i < flags.length; i++) {
    const next = () => {
      const v = flags[++i];
      if (v === undefined) fail(`${flags[i - 1]} needs a value`);
      return v;
    };
    switch (flags[i]) {
      case '--name': opts.name = next(); break;
      case '--port': opts.port = int(next(), '--port'); break;
      case '--host': opts.host = next(); break;
      case '--db': opts.db = next(); break;
      case '--gap': opts.gap = int(next(), '--gap'); break;
      case '--openai-upstream': opts.openaiUpstream = next(); break;
      case '--anthropic-upstream': opts.anthropicUpstream = next(); break;
      case '--gemini-upstream': opts.geminiUpstream = next(); break;
      case '--ollama-upstream': opts.ollamaUpstream = next(); break;
      case '--bedrock-upstream': opts.bedrockUpstream = next(); break;
      case '--auth-token': opts.authToken = next(); break;
      case '--mobile': opts.mobile = true; break;
      case '--unsafe-no-auth': opts.unsafeNoAuth = true; break;
      default: fail(`unknown flag "${flags[i]}" (command arguments go after --)`);
    }
  }
  if (opts.mobile && opts.host === DEFAULTS.host) opts.host = '0.0.0.0';

  const origin = `http://${displayHost(opts.host)}:${opts.port}`;
  requireRemoteSafety(opts);

  // Attach to a recorder that is already listening, otherwise run our own for
  // the lifetime of the child.
  let owned = null;
  let health = await getHealth(origin, opts.authToken);
  if (!health) {
    owned = createServer({
      dbPath: opts.db ?? defaultDbPath(),
      gapSeconds: opts.gap,
      providers: providersFrom(opts),
      authToken: opts.authToken,
      mobileAccess: opts.mobile
    });
    try {
      await owned.listen(opts.port, opts.host);
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        fail(`port ${opts.port} is in use by something that is not orangebox — try --port`);
      }
      fail(err.message);
    }
    health = await getHealth(origin, opts.authToken);
  }

  const { id: runId } = await postJson(`${origin}/api/runs/begin`, {
    name: opts.name ?? [command, ...commandArgs].join(' ')
  }, health, opts.authToken);

  console.log(`  ▮ recording   ${origin}/run/${runId}`);

  const env = {
    ...process.env,
    ...runScopedEnv(origin, runId),
    ORANGEBOX_RUN_ID: runId,
    ...(opts.authToken ? { ORANGEBOX_AUTH_TOKEN: opts.authToken } : {})
  };

  const code = await spawnChild(command, commandArgs, env);

  await postJson(`${origin}/api/runs/${encodeURIComponent(runId)}/end`, {}, health, opts.authToken);
  console.log(`\n  ▮ recorded    ${origin}/run/${runId}`);

  if (owned) await owned.close();
  process.exitCode = code;
}

function spawnChild(command, args, env) {
  return new Promise((resolve) => {
    const start = (useShell) => {
      const child = spawn(command, args, { stdio: 'inherit', env, shell: useShell });

      const forward = (signal) => () => {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      };
      const onInt = forward('SIGINT');
      const onTerm = forward('SIGTERM');
      process.on('SIGINT', onInt);
      process.on('SIGTERM', onTerm);

      child.on('error', (err) => {
        process.off('SIGINT', onInt);
        process.off('SIGTERM', onTerm);
        // npm/npx and friends are .cmd shims on Windows; retry through the shell.
        if (err.code === 'ENOENT' && !useShell && process.platform === 'win32') return start(true);
        console.error(`orangebox: could not run "${command}": ${err.message}`);
        resolve(127);
      });

      child.on('exit', (exitCode, signal) => {
        process.off('SIGINT', onInt);
        process.off('SIGTERM', onTerm);
        resolve(signal ? 128 : (exitCode ?? 0));
      });
    };
    start(false);
  });
}

async function getHealth(origin, authToken = null) {
  try {
    const res = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(1500),
      headers: authToken ? { 'x-orangebox-auth': authToken } : undefined
    });
    if (!res.ok) return null;
    const health = await res.json();
    return health?.ok === true && health?.csrf_token ? health : null;
  } catch {
    return null;
  }
}

async function postJson(url, body, health, authToken = null) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-orangebox-csrf': health?.csrf_token ?? '',
      ...(authToken ? { 'x-orangebox-auth': authToken } : {})
    },
    body: JSON.stringify(body ?? {})
  });
  if (!res.ok) fail(`${url} answered ${res.status}`);
  return res.json();
}

// --------------------------------------------------------------- export

async function exportRun(args) {
  const positional = [];
  let outFile = null;
  let dbPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--out') outFile = args[++i];
    else if (args[i] === '--db') dbPath = args[++i];
    else if (args[i].startsWith('-')) fail(`unknown flag "${args[i]}"`);
    else positional.push(args[i]);
  }

  const runId = positional[0];
  if (!runId) fail('usage: orangebox export <run-id> [-o file.json]');

  const { openStore } = await import('./store.mjs');
  const { buildExport } = await import('./server.mjs');
  const fs = await import('node:fs');

  const store = openStore(dbPath ?? defaultDbPath());
  try {
    const payload = buildExport(store, runId);
    if (!payload) fail(`no run with id "${runId}"`);
    const target = outFile ?? `orangebox-run-${runId}.json`;
    fs.writeFileSync(target, JSON.stringify(payload, null, 2));
    console.log(`wrote ${target}  (${payload.calls.length} calls, ${payload.tools.length} tool events)`);
  } finally {
    store.close();
  }
}

// --------------------------------------------------------------- assert

async function assertRun(args) {
  const positional = [];
  let dbPath = null;
  const limits = {};
  for (let i = 0; i < args.length; i++) {
    const next = () => {
      const value = args[++i];
      if (value === undefined) fail(`${args[i - 1]} needs a value`);
      return value;
    };
    switch (args[i]) {
      case '--db': dbPath = next(); break;
      case '--max-cost': limits.maxCost = number(next(), '--max-cost'); break;
      case '--max-latency': limits.maxLatency = number(next(), '--max-latency'); break;
      case '--max-errors': limits.maxErrors = int(next(), '--max-errors'); break;
      case '--max-calls': limits.maxCalls = int(next(), '--max-calls'); break;
      case '--require-known-cost': limits.requireKnownCost = true; break;
      default:
        if (args[i].startsWith('-')) fail(`unknown flag "${args[i]}"`);
        positional.push(args[i]);
    }
  }

  const runId = positional[0];
  if (!runId) fail('usage: orangebox assert <run-id> [thresholds]');
  const { openStore } = await import('./store.mjs');
  const store = openStore(dbPath ?? defaultDbPath());
  try {
    const run = store.getRun(runId);
    if (!run) fail(`no run with id "${runId}"`);
    const result = evaluateRunAssertions(run, store.callSummaries(runId), limits);
    if (result.ok) {
      console.log(`orangebox assertions passed for ${runId}`);
      return;
    }
    console.error(`orangebox assertions failed for ${runId}:`);
    for (const failure of result.failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}



// --------------------------------------------------------------- doctor

/** doctor reports the same config the server would actually run with. */
function configChecks(loaded, compileRedactionRules, checkConfig) {
  const { rules, errors: ruleErrors } = compileRedactionRules(loaded.config.redact ?? []);
  return checkConfig({
    present: loaded.present,
    path: loaded.path,
    errors: [...loaded.errors, ...ruleErrors],
    redactionRules: rules
  });
}

const STATUS_MARK = { ok: "ok  ", note: "note", warn: "warn", fail: "FAIL" };

/**
 * Print what orangebox actually resolved, rather than what it was asked for.
 * Exits non-zero on a failed check so it can gate a setup script.
 */
async function doctor(args) {
  let dbPath = null;
  let format = 'text';
  for (let i = 0; i < args.length; i++) {
    const next = () => {
      const value = args[++i];
      if (value === undefined) fail(`${args[i - 1]} needs a value`);
      return value;
    };
    switch (args[i]) {
      case '--db': dbPath = next(); break;
      case '--json': format = 'json'; break;
      default: fail(`unknown flag "${args[i]}"`);
    }
  }

  const { openStore } = await import('./store.mjs');
  const { loadPricing } = await import('./pricing.mjs');
  const { loadConfig, compileRedactionRules } = await import('./config.mjs');
  const {
    checkRuntime, checkDatabase, checkProviders, checkPricing, checkConfig, worst, OK
  } = await import('./doctor.mjs');

  const store = openStore(dbPath ?? defaultDbPath());
  try {
    const checks = [
      ...checkRuntime({ version: VERSION }),
      ...checkDatabase(store),
      ...checkProviders(providersFrom({
        openaiUpstream: PROVIDERS.openai,
        anthropicUpstream: PROVIDERS.anthropic
      }), { routable: ROUTABLE_PROVIDERS }),
      ...checkPricing(store, loadPricing()),
      ...configChecks(loadConfig(), compileRedactionRules, checkConfig)
    ];

    if (format === 'json') {
      console.log(JSON.stringify({ status: worst(checks), checks }, null, 2));
    } else {
      console.log();
      for (const check of checks) {
        const mark = STATUS_MARK[check.status] ?? check.status;
        const line = `  ${mark}  ${check.name.padEnd(22)} ${check.detail}`;
        console.log(check.status === 'fail' ? warn(line) : line);
      }
      console.log();
    }

    if (worst(checks) === 'fail') process.exitCode = 1;
  } finally {
    store.close();
  }
}




// --------------------------------------------------------------- import

/** §10.7 — read a run somebody exported into this database. */
async function importFile(args) {
  const positional = [];
  let dbPath = null;
  let name = null;

  for (let i = 0; i < args.length; i++) {
    const next = () => {
      const value = args[++i];
      if (value === undefined) fail(`${args[i - 1]} needs a value`);
      return value;
    };
    switch (args[i]) {
      case '--db': dbPath = next(); break;
      case '--name': name = next(); break;
      default:
        if (args[i].startsWith('-')) fail(`unknown flag "${args[i]}"`);
        positional.push(args[i]);
    }
  }

  const file = positional[0];
  if (!file) fail('usage: orangebox import <export.json> [--name "..."]');

  const nodeFs = await import('node:fs');
  let payload;
  try {
    payload = JSON.parse(nodeFs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`could not read ${file}: ${error.message}`);
  }

  const { openStore } = await import('./store.mjs');
  const { importRun, ImportError } = await import('./import.mjs');
  const store = openStore(dbPath ?? defaultDbPath());
  try {
    const result = importRun(store, payload, { name });
    console.log(`imported ${result.calls} call(s) and ${result.tools} tool event(s) as "${result.name}"`);
    if (result.renamed) {
      console.log('  a run with that id already existed, so this one was given a new one');
    }
    if (result.exported_by && result.exported_by !== VERSION) {
      console.log(`  exported by orangebox v${result.exported_by}; you are running v${VERSION}`);
    }
    console.log(`  ${result.run_id}`);
  } catch (error) {
    if (error instanceof ImportError) fail(error.message);
    throw error;
  } finally {
    store.close();
  }
}
// ---------------------------------------------------------------- prune

/**
 * Reclaim space. Age, size, or just a rebuild of the file.
 */
async function prune(args) {
  let dbPath = null;
  let days = null;
  let maxBytes = null;
  let vacuumOnly = false;
  let yes = false;

  for (let i = 0; i < args.length; i++) {
    const next = () => {
      const value = args[++i];
      if (value === undefined) fail(`${args[i - 1]} needs a value`);
      return value;
    };
    switch (args[i]) {
      case '--db': dbPath = next(); break;
      case '--older-than': days = int(next(), '--older-than'); break;
      case '--max-size': maxBytes = parseSize(next()); break;
      case '--vacuum': vacuumOnly = true; break;
      case '--yes': case '-y': yes = true; break;
      default: fail(`unknown flag "${args[i]}"`);
    }
  }

  if (days === null && maxBytes === null && !vacuumOnly) {
    fail('usage: orangebox prune [--older-than <days>] [--max-size <e.g. 500MB>] [--vacuum]');
  }

  const { openStore } = await import('./store.mjs');
  const store = openStore(dbPath ?? defaultDbPath());
  try {
    const before = store.sizeBytes();
    const runsBefore = store.countRuns();
    console.log(`  ${store.path}`);
    console.log(`  ${runsBefore} run(s), ${formatBytes(before)}`);

    // Deleting recordings is not undoable, so say what will go and ask —
    // unless the caller has already said yes, as a script would.
    if (!vacuumOnly && !yes) {
      const doomed = describePlan(store, { days, maxBytes });
      if (doomed === 0) {
        console.log('  nothing matches — nothing to do.');
        return;
      }
      const ok = await confirm(`  delete ${doomed} run(s)? [y/N] `);
      if (!ok) {
        console.log('  cancelled.');
        return;
      }
    }

    let deleted = 0;
    if (days !== null) deleted += store.retain(days);
    if (maxBytes !== null) deleted += store.pruneToSize(maxBytes).deleted;
    if (vacuumOnly && deleted === 0) store.vacuum();
    else store.vacuum();

    const after = store.sizeBytes();
    console.log(`  deleted ${deleted} run(s), reclaimed ${formatBytes(Math.max(0, before - after))}`);
    console.log(`  now ${store.countRuns()} run(s), ${formatBytes(after)}`);
  } finally {
    store.close();
  }
}

/** How many runs the requested prune would remove, without removing them. */
function describePlan(store, { days, maxBytes }) {
  let doomed = 0;
  if (days !== null) {
    const cutoff = Date.now() - days * 86_400_000;
    doomed += store.db.prepare('SELECT COUNT(*) n FROM runs WHERE started_at < ?').get(cutoff).n;
  }
  if (maxBytes !== null && store.sizeBytes() > maxBytes) {
    // Size pruning is iterative, so this is a floor rather than an exact
    // count. Saying "at least" beats implying precision we do not have.
    doomed += 1;
  }
  return doomed;
}

/** "500MB", "2GB", "1048576" — the forms people actually type. */
export function parseSize(text) {
  // Built from a string rather than a literal: the whitespace class in this
  // file has been eaten in transit before, and /s*/ silently rejects "700 kb"
  // while accepting everything else, which looks like a picky parser.
  const SIZE = new RegExp('^([0-9]+(?:[.][0-9]+)?)[ \t]*(B|KB|MB|GB)?$', 'i');
  const match = String(text).trim().match(SIZE);
  if (!match) fail(`--max-size needs a size like 500MB, got "${text}"`);
  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.round(Number(match[1]) * units[(match[2] ?? 'B').toLowerCase()]);
}
// ----------------------------------------------------------------- find

/**
 * §19.9 — grep your own recorded prompts and responses.
 */
async function findCalls(args) {
  const positional = [];
  let dbPath = null;
  let limit = 20;
  let since = null;
  let until = null;
  let format = 'text';

  for (let i = 0; i < args.length; i++) {
    const next = () => {
      const value = args[++i];
      if (value === undefined) fail(`${args[i - 1]} needs a value`);
      return value;
    };
    switch (args[i]) {
      case '--db': dbPath = next(); break;
      case '--limit': case '-n': limit = int(next(), '--limit'); break;
      case '--since': since = epochArg(next(), '--since'); break;
      case '--until': until = epochArg(next(), '--until'); break;
      case '--days': since = Date.now() - int(next(), '--days') * 86_400_000; break;
      case '--json': format = 'json'; break;
      default:
        if (args[i].startsWith('-')) fail(`unknown flag "${args[i]}"`);
        positional.push(args[i]);
    }
  }

  const query = positional.join(' ');
  if (!query) fail('usage: orangebox find <text> [--limit n] [--days n]');

  const { openStore } = await import('./store.mjs');
  const store = openStore(dbPath ?? defaultDbPath());
  try {
    const found = store.searchCalls({ query, limit, since, until });
    if (format === 'json') return void console.log(JSON.stringify(found, null, 2));

    if (found.total === 0) {
      console.log(`no recorded call contains ${JSON.stringify(query)}`);
      return;
    }

    console.log();
    for (const hit of found.results) {
      const when = new Date(hit.started_at).toISOString().replace(/[TZ]/g, " ").slice(0, 19);
      const flags = [hit.where, hit.error_type].filter(Boolean).join(', ');
      console.log(`  ${hit.run_name}  ·  call ${String(hit.seq).padStart(2, "0")}  ·  ${hit.model ?? "?"}  ·  ${when} (${flags})`);
      console.log(`    ${highlight(collapse(hit.snippet ?? ''), query)}`);
      console.log(`    ${hit.id}`);
      console.log();
    }

    const capped = found.total === found.limit;
    console.log(`  ${found.total} match${found.total === 1 ? "" : "es"}${capped ? ` (capped at ${found.limit}; raise it with --limit)` : ""}`);
    console.log();
  } finally {
    store.close();
  }
}

/**
 * Snippets come from JSON blobs, so they arrive full of newlines and padding.
 *
 * The whitespace class is built with String.fromCharCode rather than written
 * as a regex literal, because that literal has lost its backslash in transit
 * before — and the resulting /s+/ silently deletes every letter s from the
 * output, which reads as a font problem rather than a bug.
 */
function collapse(text) {
  const WHITESPACE = new RegExp(String.fromCharCode(92) + 's+', 'g');
  return String(text).replace(WHITESPACE, ' ').trim();
}

/** Mark the hit, when a human is watching. */
function highlight(text, query) {
  if (!useColour()) return text;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return text;
  const ESC = String.fromCharCode(27);
  return text.slice(0, at) +
    ESC + "[1m" + text.slice(at, at + query.length) + ESC + "[0m" +
    text.slice(at + query.length);
}
// ---------------------------------------------------------------- tools

/**
 * §19.8 — which tools the agent leans on, which fail, and which are slow.
 */
async function toolReport(args) {
  let dbPath = null;
  let since = null;
  let until = null;
  let format = 'table';

  for (let i = 0; i < args.length; i++) {
    const next = () => {
      const value = args[++i];
      if (value === undefined) fail(`${args[i - 1]} needs a value`);
      return value;
    };
    switch (args[i]) {
      case '--db': dbPath = next(); break;
      case '--since': since = epochArg(next(), '--since'); break;
      case '--until': until = epochArg(next(), '--until'); break;
      case '--days': since = Date.now() - int(next(), '--days') * 86_400_000; break;
      case '--json': format = 'json'; break;
      case '--csv': format = 'csv'; break;
      default: fail(`unknown flag "${args[i]}"`);
    }
  }

  const { openStore } = await import('./store.mjs');
  const store = openStore(dbPath ?? defaultDbPath());
  try {
    const data = store.toolStats({ since, until });
    if (format === 'json') return void console.log(JSON.stringify(data, null, 2));
    if (format === 'csv') return void printToolCsv(data);
    printToolTable(data);
  } finally {
    store.close();
  }
}

function printToolTable(data) {
  if (data.total_uses === 0) {
    console.log('No tool calls recorded in that window.');
    return;
  }

  const width = Math.min(Math.max(...data.tools.map((t) => t.key.length), 4), 30);
  console.log();
  console.log(`  ${'tool'.padEnd(width)}  ${'uses'.padStart(6)}  ${'errors'.padStart(7)}  ${'avg'.padStart(9)}  ${'slowest'.padStart(9)}`);
  console.log();

  for (const tool of data.tools) {
    const errors = tool.errors > 0 ? warn(String(tool.errors).padStart(7)) : String(tool.errors).padStart(7);
    // avg is null when every use of this tool shared a call with others, so
    // there is no gap that belongs to it alone.
    const avg = (tool.avg_ms === null ? '—' : ms(tool.avg_ms)).padStart(9);
    const slowest = (tool.slowest_ms === null ? '—' : ms(tool.slowest_ms)).padStart(9);
    const notes = [];
    if (tool.unanswered > 0) notes.push(`${tool.unanswered} unanswered`);
    if (tool.avg_ms !== null && tool.timed_uses < tool.uses) {
      notes.push(`timed on ${tool.timed_uses}/${tool.uses}`);
    }
    const trailer = notes.length ? warn(`  (${notes.join(', ')})`) : '';
    console.log(`  ${truncate(tool.key, width).padEnd(width)}  ${String(tool.uses).padStart(6)}  ${errors}  ${avg}  ${slowest}${trailer}`);
  }

  console.log();
  console.log(`  ${data.total_uses} tool call(s), ${data.total_errors} errored, ${data.total_unanswered} never answered`);
  if (data.total_unanswered > 0) {
    console.log(warn('  an unanswered call is one the model made and never got a result for — a broken loop, a crash, or a run cut short.'));
  }
  console.log();
}

function printToolCsv(data) {
  console.log('tool,uses,runs,errors,unanswered,error_rate,timed_uses,avg_ms,slowest_ms');
  for (const t of data.tools) {
    console.log([
      csvCell(t.key), t.uses, t.runs, t.errors, t.unanswered,
      t.error_rate.toFixed(4), t.timed_uses, t.avg_ms ?? '', t.slowest_ms ?? ''
    ].join(','));
  }
}

function ms(value) {
  if (value === null || value === undefined) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}
// ---------------------------------------------------------------- spend

/**
 * §19.5 in a terminal. The same numbers the web view shows, for people on a
 * box with no browser — which is most CI, and plenty of servers.
 */
async function spendReport(args) {
  let dbPath = null;
  let groupBy = 'model';
  let since = null;
  let until = null;
  let format = 'table';

  for (let i = 0; i < args.length; i++) {
    const next = () => {
      const value = args[++i];
      if (value === undefined) fail(`${args[i - 1]} needs a value`);
      return value;
    };
    switch (args[i]) {
      case '--db': dbPath = next(); break;
      case '--group': case '-g': groupBy = next(); break;
      case '--since': since = epochArg(next(), '--since'); break;
      case '--until': until = epochArg(next(), '--until'); break;
      case '--days': {
        const n = int(next(), '--days');
        since = Date.now() - n * 86_400_000;
        break;
      }
      case '--json': format = 'json'; break;
      case '--csv': format = 'csv'; break;
      default:
        fail(`unknown flag "${args[i]}"`);
    }
  }

  const { openStore } = await import('./store.mjs');
  const store = openStore(dbPath ?? defaultDbPath());
  try {
    let data;
    try {
      data = store.spend({ groupBy, since, until });
    } catch (err) {
      fail(`${err.message} — try one of: model, provider, run, day`);
    }

    if (format === 'json') return void console.log(JSON.stringify(data, null, 2));
    if (format === 'csv') return void printSpendCsv(data);
    printSpendTable(data);
  } finally {
    store.close();
  }
}

/** Epoch ms, or anything Date can parse ('2026-07-01'). */
function epochArg(value, flag) {
  if (/^d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) fail(`${flag} needs a date or epoch ms, got "${value}"`);
  return parsed;
}
// Colour only when a human is watching. Piping `orangebox spend` into a file
// or a CI log should produce text, not escape sequences.
const useColour = () => process.stdout.isTTY === true && !process.env.NO_COLOR;
const warn = (text) => (useColour() ? String.fromCharCode(27) + '[33m' + text + String.fromCharCode(27) + '[0m' : text);

const BAR_WIDTH = 34;

function printSpendTable(data) {
  if (data.total_calls === 0) {
    console.log('No calls recorded in that window.');
    return;
  }

  const groups = data.groups;
  const keyWidth = Math.min(Math.max(...groups.map((g) => g.key.length), 5), 34);
  const max = Math.max(...groups.map((g) => g.cost_usd), 0);

  console.log();
  console.log(`  spend by ${data.group_by}${describeWindow(data)}`);
  console.log();

  for (const g of groups) {
    const filled = max > 0 ? Math.round((g.cost_usd / max) * BAR_WIDTH) : 0;
    // A group that cost something always shows at least one block, so a
    // cheap-but-real row never renders as an empty line.
    const bar = '#'.repeat(g.cost_usd > 0 ? Math.max(filled, 1) : 0).padEnd(BAR_WIDTH);
    const key = truncate(g.key, keyWidth).padEnd(keyWidth);
    const cost = (usd(g.cost_usd) + (g.unpriced_calls > 0 ? '+' : '')).padStart(10);
    const calls = String(g.calls).padStart(5) + ' calls';

    const notes = [];
    if (g.unrated_calls > 0) notes.push(`${g.unrated_calls} unrated`);
    if (g.no_usage_calls > 0) notes.push(`${g.no_usage_calls} no usage`);
    if (g.unrated_calls === undefined && g.unpriced_calls > 0) {
      notes.push(`${g.unpriced_calls} unpriced`);
    }
    const flag = notes.length ? warn(`  (${notes.join(', ')})`) : '';

    console.log(`  ${key}  ${bar}  ${cost}  ${calls}${flag}`);
  }

  console.log();
  const plus = data.unpriced_calls > 0 ? '+' : '';
  console.log(`  total ${usd(data.total_cost_usd)}${plus} across ${data.total_calls} call(s)`);

  // Same rule as the web view: never print the total without printing how
  // complete it is. A number that is quietly too low is worse than no number —
  // and saying *why* it is short matters, because the two reasons have
  // opposite remedies.
  if (data.unpriced_calls > 0) {
    const pct = Math.round(data.priced_share * 100);
    console.log(
      warn(`  covers ${pct}% of calls — ${data.unpriced_calls} of ${data.total_calls} added nothing, so the real figure is higher.`)
    );
    if (data.unrated_calls > 0) {
      console.log(warn(`  ${data.unrated_calls} have no rate for their model — add them to ~/.orangebox/pricing.json.`));
    }
    if (data.no_usage_calls > 0) {
      console.log(warn(`  ${data.no_usage_calls} reported no token counts (errored, aborted, or streamed without usage); their cost is unknowable.`));
    }
    if (data.unrated_calls === undefined) {
      console.log(warn(`  add rates to ~/.orangebox/pricing.json to close the gap.`));
    }
  }
  console.log();
}

/** Machine-readable, for a spreadsheet or a chart someone else draws. */
function printSpendCsv(data) {
  console.log('key,calls,input_tokens,output_tokens,cost_usd,unpriced_calls,unrated_calls,no_usage_calls,error_calls');
  for (const g of data.groups) {
    console.log([
      csvCell(g.key),
      g.calls,
      g.input_tokens,
      g.output_tokens,
      g.cost_usd,
      g.unpriced_calls,
      g.unrated_calls,
      g.no_usage_calls,
      g.error_calls
    ].join(','));
  }
}

/**
 * Quote anything a spreadsheet would misread. Run names are user text and can
 * hold commas, quotes and newlines.
 */
export function csvCell(value) {
  const text = String(value ?? '');
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const risky = text.includes(',') || text.includes('"') || text.includes(CR) || text.includes(LF);
  return risky ? '"' + text.split('"').join('""') + '"' : text;
}

function describeWindow({ since, until }) {
  if (!since && !until) return ' (all time)';
  const d = (ms) => new Date(ms).toISOString().slice(0, 10);
  if (since && until) return ` (${d(since)} to ${d(until)})`;
  return since ? ` (since ${d(since)})` : ` (until ${d(until)})`;
}

export function truncate(text, width) {
  return text.length > width ? text.slice(0, width - 1) + '…' : text;
}

function usd(v) {
  if (v === null || v === undefined) return '—';
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(v < 1 ? 3 : 2)}`;
}

// ---------------------------------------------------------------- clear

async function clear(args) {
  let yes = args.includes('--yes') || args.includes('-y');
  const dbIndex = args.indexOf('--db');
  const dbPath = dbIndex >= 0 ? args[dbIndex + 1] : null;

  const { openStore } = await import('./store.mjs');
  const store = openStore(dbPath ?? defaultDbPath());
  try {
    const runs = store.countRuns();
    if (runs === 0) {
      console.log('nothing to clear — the database is empty.');
      return;
    }
    if (!yes) {
      yes = await confirm(`Delete all ${runs} recorded run(s) from ${store.path}? [y/N] `);
      if (!yes) {
        console.log('cancelled.');
        return;
      }
    }
    store.clearAll();
    console.log(`cleared ${runs} run(s).`);
  } finally {
    store.close();
  }
}

function confirm(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(false);
    process.stdout.write(prompt);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      process.stdin.pause();
      resolve(/^y(es)?$/i.test(String(data).trim()));
    });
  });
}

// --------------------------------------------------------------- helpers

function openBrowser(url) {
  // Dependency-free (§05.1); failures are not the user's problem.
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* ignored on purpose */
  }
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function requireRemoteSafety(opts) {
  if (!isLoopback(opts.host) && !opts.authToken && !opts.mobile && !opts.unsafeNoAuth) {
    fail('non-loopback --host requires --auth-token <token>, --mobile, or --unsafe-no-auth');
  }
}

function lanOrigin(port) {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return `http://${address.address}:${port}`;
    }
  }
  return `http://localhost:${port}`;
}

/**
 * Start from the shipped defaults and override only what a flag supplies.
 *
 * This used to name its two providers literally, so gemini, ollama and
 * bedrock — routable, parsed, and priced — resolved to undefined here and
 * every request to them was proxied to "undefined/v1/...". Spreading
 * PROVIDERS means adding a provider to that table is enough; there is no
 * second list to remember.
 */
export function providersFrom(opts) {
  return {
    ...PROVIDERS,
    openai: upstream(opts.openaiUpstream, '--openai-upstream'),
    anthropic: upstream(opts.anthropicUpstream, '--anthropic-upstream'),
    ...(opts.geminiUpstream ? { gemini: upstream(opts.geminiUpstream, '--gemini-upstream') } : {}),
    ...(opts.ollamaUpstream ? { ollama: upstream(opts.ollamaUpstream, '--ollama-upstream') } : {}),
    ...(opts.bedrockUpstream ? { bedrock: upstream(opts.bedrockUpstream, '--bedrock-upstream') } : {})
  };
}

function upstream(value, flag) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch {
    fail(`${flag} needs an http(s) URL, got "${value}"`);
  }
}

function displayHost(host) {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

/**
 * The environment variables that point an agent's SDK at a run-scoped prefix.
 *
 * One entry per provider orangebox can record, because `orangebox run` setting
 * only two of five meant a Gemini or Ollama agent was wrapped, reported as
 * recording, and produced an empty run — the same shape of gap as the provider
 * routing bug, in a different file.
 *
 * SDKs disagree about which variable they read, and some read none. Setting one
 * an SDK ignores costs nothing, so this errs towards covering the documented
 * name for each; anything unrecognised is simply inert in the child process.
 */
export function runScopedEnv(origin, runId) {
  const base = (provider) => `${origin}/r/${encodeURIComponent(runId)}/${provider}`;
  return {
    ANTHROPIC_BASE_URL: base('anthropic'),
    OPENAI_BASE_URL: base('openai'),
    // Google's GenAI SDKs read this; older ones take a baseUrl in code instead.
    GOOGLE_GEMINI_BASE_URL: base('gemini'),
    // Ollama's own tooling and clients read OLLAMA_HOST.
    OLLAMA_HOST: base('ollama'),
    // AWS SDK v3 honours a per-service endpoint override.
    AWS_ENDPOINT_URL_BEDROCK_RUNTIME: base('bedrock')
  };
}

function environmentCommands(origin) {
  if (process.platform === 'win32') {
    return [
      `$env:ANTHROPIC_BASE_URL="${origin}/anthropic"`,
      `$env:OPENAI_BASE_URL="${origin}/openai"`
    ];
  }
  return [
    `export ANTHROPIC_BASE_URL="${origin}/anthropic"`,
    `export OPENAI_BASE_URL="${origin}/openai"`
  ];
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function int(value, flag) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) fail(`${flag} needs a number, got "${value}"`);
  return n;
}

function number(value, flag) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`${flag} needs a non-negative number, got "${value}"`);
  return n;
}

function fail(message) {
  console.error(`orangebox: ${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`
orangebox v${VERSION} — flight recorder for AI agents

USAGE
  orangebox [start] [options]          start recording (default command)
  orangebox run [--name "..."] -- CMD  run CMD with its calls grouped into one run
  orangebox export <run-id> [-o file]  write a run to a self-contained JSON file
  orangebox assert <run-id> [limits]    fail CI when a recorded run exceeds a limit
  orangebox spend [--group <k>]        what your agents have cost so far
  orangebox find <text>                search your recorded prompts and responses
  orangebox tools                      which tools get used, fail, and take time
  orangebox doctor                     show what orangebox actually resolved
  orangebox import <file.json>         load a run somebody exported
  orangebox prune [--older-than <d>]   reclaim space; also --max-size, --vacuum
  orangebox clear [--yes]              delete all recorded data
  orangebox --version | --help

OPTIONS (start)
  --port <n>       listen port                        (default 4100)
  --db <path>      database location                  (default ~/.orangebox/orangebox.db)
  --host <addr>    bind address                       (default 127.0.0.1)
  --gap <seconds>  idle gap that starts a new run     (default 120)
  --retain <days>  delete runs older than N days      (default 0 = keep forever)
  --openai-upstream <url>     OpenAI-compatible upstream
  --anthropic-upstream <url>  Anthropic-compatible upstream
  --gemini-upstream <url>     Gemini-compatible upstream
  --ollama-upstream <url>     Ollama host (or set OLLAMA_HOST)
  --bedrock-upstream <url>    Bedrock runtime endpoint (or set AWS_REGION)
  --auth-token <token>        require x-orangebox-auth (required for safe remote use)
  --mobile                    bind to the LAN with read-only device pairing
  --unsafe-no-auth            allow a non-loopback host without authentication
  --no-open        don't open the browser on start

SPEND OPTIONS
  --group <k>, -g <k>       model (default), provider, run or day
  --days <n>                only the last n days
  --since <d> --until <d>   epoch ms, or a date like 2026-07-01
  --csv                     machine-readable rows
  --json                    the full response, totals included

ASSERT LIMITS
  --max-cost <usd>          maximum total estimated cost
  --max-latency <ms>        maximum latency of any call
  --max-errors <n>          maximum error count
  --max-calls <n>           maximum agent-loop call count
  --require-known-cost      fail when any call has unknown cost

EASIEST START
  orangebox run --name "checkout bot" -- node agent.js

POINT AN EXISTING PROCESS AT IT
  ${environmentCommands('http://127.0.0.1:4100').join('\n  ')}

  Gemini, Ollama and Bedrock record the same way, at /gemini, /ollama and
  /bedrock. The run wrapper sets the variable for every provider itself.
`);
}
