// §05 — command-line interface. Hand-rolled arg parsing; the dependency budget
// is one package and better-sqlite3 already spent it.
import { spawn } from 'node:child_process';
import process from 'node:process';

import { createServer, VERSION } from './server.mjs';
import { defaultDbPath } from './store.mjs';

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
  unsafeNoAuth: false
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
  const out = { ...DEFAULTS };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => {
      const v = args[++i];
      if (v === undefined) fail(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--port': out.port = int(next(), '--port'); break;
      case '--host': out.host = next(); break;
      case '--db': out.db = next(); break;
      case '--gap': out.gap = int(next(), '--gap'); break;
      case '--retain': out.retain = int(next(), '--retain'); break;
      case '--openai-upstream': out.openaiUpstream = next(); break;
      case '--anthropic-upstream': out.anthropicUpstream = next(); break;
      case '--auth-token': out.authToken = next(); break;
      case '--unsafe-no-auth': out.unsafeNoAuth = true; break;
      case '--no-open': out.open = false; break;
      case '--help': case '-h': printHelp(); process.exit(0);
      default: fail(`unknown flag "${arg}"`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ start

async function start(opts) {
  requireRemoteSafety(opts);
  const dbPath = opts.db ?? defaultDbPath();
  let app;
  try {
    app = createServer({
      dbPath,
      gapSeconds: opts.gap,
      providers: providersFrom(opts),
      authToken: opts.authToken
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
  banner({ origin, store: app.store, host: opts.host, willOpen: opts.open, authToken: opts.authToken });

  if (opts.open) openBrowser(opts.authToken ? `${origin}?token=${encodeURIComponent(opts.authToken)}` : origin);

  const shutdown = () => {
    app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return app;
}

function banner({ origin, store, host, willOpen, authToken }) {
  const size = store.sizeBytes();
  const runs = store.countRuns();
  console.log('');
  console.log(`  ▮ orangebox v${VERSION} — flight recorder for AI agents`);
  console.log(`  ▮ recording on   ${origin}`);
  console.log(`  ▮ database       ${store.path}  (${runs} run${runs === 1 ? '' : 's'}, ${formatBytes(size)})`);
  console.log('  ▮ point your agent at it:');
  console.log(`  ▮   export ANTHROPIC_BASE_URL="${origin}/anthropic"`);
  console.log(`  ▮   export OPENAI_BASE_URL="${origin}/openai"`);
  console.log(`  ▮ ui             ${origin}${willOpen ? '  (opening browser…)' : ''}`);
  if (authToken) console.log('  ▮ authentication x-orangebox-auth is required');
  console.log('');

  if (!isLoopback(host) && !authToken) {
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
      case '--auth-token': opts.authToken = next(); break;
      case '--unsafe-no-auth': opts.unsafeNoAuth = true; break;
      default: fail(`unknown flag "${flags[i]}" (command arguments go after --)`);
    }
  }

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
      authToken: opts.authToken
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
    ANTHROPIC_BASE_URL: `${origin}/r/${runId}/anthropic`,
    OPENAI_BASE_URL: `${origin}/r/${runId}/openai`,
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
  if (!isLoopback(opts.host) && !opts.authToken && !opts.unsafeNoAuth) {
    fail('non-loopback --host requires --auth-token <token> or --unsafe-no-auth');
  }
}

function providersFrom(opts) {
  return {
    openai: upstream(opts.openaiUpstream, '--openai-upstream'),
    anthropic: upstream(opts.anthropicUpstream, '--anthropic-upstream')
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
  --auth-token <token>        require x-orangebox-auth (required for safe remote use)
  --unsafe-no-auth            allow a non-loopback host without authentication
  --no-open        don't open the browser on start

POINT YOUR AGENT AT IT
  export ANTHROPIC_BASE_URL="http://127.0.0.1:4100/anthropic"
  export OPENAI_BASE_URL="http://127.0.0.1:4100/openai"

  …or skip the env vars entirely and let orangebox set them for you:
  orangebox run --name "checkout bot" -- node agent.js
`);
}
