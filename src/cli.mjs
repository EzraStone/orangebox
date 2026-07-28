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
  retain: 0
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
      case '--no-open': out.open = false; break;
      case '--help': case '-h': printHelp(); process.exit(0);
      default: fail(`unknown flag "${arg}"`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ start

async function start(opts) {
  const dbPath = opts.db ?? defaultDbPath();
  let app;
  try {
    app = createServer({ dbPath, gapSeconds: opts.gap });
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
  banner({ origin, store: app.store, host: opts.host, willOpen: opts.open });

  if (opts.open) openBrowser(origin);

  const shutdown = () => {
    app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return app;
}

function banner({ origin, store, host, willOpen }) {
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
  console.log('');

  if (!isLoopback(host)) {
    console.error(
      `\x1b[31mWARNING: orangebox has no authentication. Binding to ${host} exposes every recorded prompt to your network.\x1b[0m\n`
    );
  }
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
  orangebox export <run-id> [-o file]  write a run to a self-contained JSON file
  orangebox clear [--yes]              delete all recorded data
  orangebox --version | --help

OPTIONS (start)
  --port <n>       listen port                        (default 4100)
  --db <path>      database location                  (default ~/.orangebox/orangebox.db)
  --host <addr>    bind address                       (default 127.0.0.1)
  --gap <seconds>  idle gap that starts a new run     (default 120)
  --retain <days>  delete runs older than N days      (default 0 = keep forever)
  --no-open        don't open the browser on start

POINT YOUR AGENT AT IT
  export ANTHROPIC_BASE_URL="http://127.0.0.1:4100/anthropic"
  export OPENAI_BASE_URL="http://127.0.0.1:4100/openai"
`);
}
