// `orangebox doctor` — the command that would have caught the 1.2.0 provider bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, newId } from '../src/store.mjs';
import { loadPricing } from '../src/pricing.mjs';
import {
  checkProviders, checkRuntime, checkDatabase, checkWritable, checkPricing, checkConfig, worst,
  OK, NOTE, FAIL
} from '../src/doctor.mjs';

const ROUTABLE = ['anthropic', 'openai', 'gemini', 'ollama', 'bedrock'];

const FULL = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com',
  ollama: 'http://127.0.0.1:11434',
  bedrock: 'https://bedrock-runtime.us-east-1.amazonaws.com'
};

test('a routable provider with no upstream fails loudly, not by omission', () => {
  // Exactly what shipped in 1.2.0. Iterating the configured map would report
  // this by simply not printing three rows, and a missing row is the one thing
  // nobody notices in a list of ticks.
  const partial = { anthropic: FULL.anthropic, openai: FULL.openai };
  const checks = checkProviders(partial, { env: {}, routable: ROUTABLE });

  assert.equal(checks.length, 5, 'every routable provider is reported');
  const failures = checks.filter((c) => c.status === FAIL).map((c) => c.provider);
  assert.deepEqual(failures.sort(), ['bedrock', 'gemini', 'ollama']);
  for (const check of checks.filter((c) => c.status === FAIL)) {
    assert.match(check.detail, /no upstream/);
  }
  assert.equal(worst(checks), FAIL);
});

test('a fully configured install has nothing failing', () => {
  const checks = checkProviders(FULL, { env: {}, routable: ROUTABLE });
  assert.equal(checks.filter((c) => c.status === FAIL).length, 0);
  assert.notEqual(worst(checks), FAIL);
});

test('a provider needing no key reads ok, not as a warning', () => {
  // Ollama is local. Reporting it as "needs a key" would be wrong, and
  // reporting it as a problem would train people to ignore the output.
  const [check] = checkProviders({ ollama: FULL.ollama }, { env: {}, routable: ['ollama'] });
  assert.equal(check.status, OK);
  assert.match(check.detail, /no key needed/);
});

test('a present key is credited by variable name, never by value', () => {
  const [check] = checkProviders(
    { anthropic: FULL.anthropic },
    { env: { ANTHROPIC_API_KEY: 'sk-ant-super-secret' }, routable: ['anthropic'] }
  );
  assert.equal(check.status, OK);
  assert.match(check.detail, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(JSON.stringify(check), /sk-ant-super-secret/, 'a key value must never appear');
});

test('a missing key is a note, because recording still works without it', () => {
  const [check] = checkProviders({ gemini: FULL.gemini }, { env: {}, routable: ['gemini'] });
  assert.equal(check.status, NOTE);
  assert.match(check.detail, /recording works/);
  assert.match(check.detail, /GEMINI_API_KEY/);
});

test('a malformed upstream is reported as a failure', () => {
  const checks = checkProviders({ openai: 'not a url' }, { env: {}, routable: ['openai'] });
  assert.equal(checks[0].status, FAIL);
  assert.match(checks[0].detail, /not a URL/);
});

test('an old node is a failure, a current one is not', () => {
  assert.equal(checkRuntime({ version: '1.2.1', nodeVersion: 'v18.19.0' })[1].status, FAIL);
  assert.equal(checkRuntime({ version: '1.2.1', nodeVersion: 'v20.0.0' })[1].status, OK);
  assert.equal(checkRuntime({ version: '1.2.1', nodeVersion: 'v24.15.0' })[1].status, OK);
});

test('database and pricing checks describe a real store', () => {
  const store = new Store(':memory:');
  const run = store.createRun({ source: 'gap' });
  store.insertCall({
    id: newId(), run_id: run.id, seq: store.nextSeq(run.id),
    provider: 'openai', endpoint: '/v1/chat/completions', model: 'never-priced-model',
    started_at: Date.now(), request_json: '{}',
    input_tokens: 100, output_tokens: 20, cost_usd: null
  });

  const db = checkDatabase(store);
  assert.equal(db[0].status, OK);
  assert.match(db[0].detail, /1 run\(s\)/);
  assert.match(db[0].detail, /schema v2/);

  const pricing = checkPricing(store, loadPricing({ userFile: '/nonexistent' }));
  assert.match(pricing[0].detail, /model rates/);
  const unrated = pricing.find((c) => c.name === 'unpriced models');
  assert.ok(unrated, 'a model with no rate is surfaced');
  assert.match(unrated.detail, /never-priced-model/);

  store.close();
});

test('worst() ranks outcomes so the exit code can key off it', () => {
  assert.equal(worst([]), OK);
  assert.equal(worst([{ status: OK }, { status: NOTE }]), NOTE);
  assert.equal(worst([{ status: NOTE }, { status: FAIL }, { status: OK }]), FAIL);
});

test('a missing config file is reported as fine, not as absent', () => {
  const [config, redaction] = checkConfig({ present: false, redactionRules: [] });
  assert.equal(config.status, OK);
  assert.match(config.detail, /using flags and defaults/);
  assert.equal(redaction.status, OK);
});

test('config problems are surfaced one per line', () => {
  const checks = checkConfig({
    present: true,
    path: '/home/.orangebox/config.json',
    errors: ['config: unknown setting "prot" — ignored', 'config: "port" must be a port number'],
    redactionRules: []
  });
  assert.equal(checks[0].status, 'warn');
  assert.match(checks[0].detail, /2 problems/);
  assert.equal(checks.filter((c) => c.name === 'config problem').length, 2);
});

test('active redaction is always stated, even when nothing is wrong', () => {
  // A database recorded through filters is a different artifact from one
  // recorded without them. Whoever reads it later needs to know which.
  const checks = checkConfig({
    present: true,
    path: '/c.json',
    errors: [],
    redactionRules: [{ label: 'accounts' }, { label: 'hostnames' }]
  });
  const redaction = checks.find((c) => c.name === 'redaction');
  assert.equal(redaction.status, NOTE);
  assert.match(redaction.detail, /accounts, hostnames/);
});

test('the writable probe rolls itself back', async () => {
  // It writes a real row, because opening a database for writing is not the
  // same as being able to write to it — SQLite defers that failure until it
  // needs the file. So the probe has to leave nothing behind.
  const fsMod = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Store } = await import('../src/store.mjs');

  const dir = fsMod.mkdtempSync(path.join(os.tmpdir(), 'orangebox-writable-'));
  const store = new Store(path.join(dir, 'w.db'));

  try {
    const [check] = checkWritable(store);
    assert.equal(check.status, OK);
    assert.match(check.detail, /accepts writes/);

    const probe = store.db.prepare("SELECT value FROM meta WHERE key = 'doctor_probe'").get();
    assert.equal(probe, undefined, 'the probe row must not survive');
  } finally {
    store.close();
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
});

test('an in-memory database is a note, not a pass or a failure', () => {
  const store = new Store(':memory:');
  try {
    const [check] = checkWritable(store);
    assert.equal(check.status, NOTE);
    assert.match(check.detail, /nothing is persisted/);
  } finally {
    store.close();
  }
});

test('a database that cannot be written to fails loudly', async () => {
  // The worst failure this tool has is recording nothing and saying nothing.
  // Reading works fine on a read-only database, so every other check passes.
  const broken = {
    path: '/somewhere/real.db',
    db: {
      transaction() {
        return () => {
          throw new Error('attempt to write a readonly database');
        };
      }
    }
  };

  const [check] = checkWritable(broken);
  assert.equal(check.status, FAIL);
  assert.match(check.detail, /readonly/);
  assert.match(check.detail, /fail silently/, 'says what the consequence is');
});
