// `orangebox doctor` — the command that would have caught the 1.2.0 provider bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, newId, SCHEMA_VERSION } from '../src/store.mjs';
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
  assert.ok(db[0].detail.includes(`schema v${SCHEMA_VERSION}`), db[0].detail);

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

test('TLS is reported as off when no certificate has been made', async () => {
  const { checkTls } = await import('../src/doctor.mjs');
  const [check] = checkTls({ dir: '/nowhere', read: () => { throw new Error('ENOENT'); } });
  assert.equal(check.status, OK, 'not having HTTPS is a choice, not a problem');
  assert.match(check.detail, /--https/);
});

test('a certificate close to expiry is flagged before it bites', async () => {
  // Expiring mid-session takes the mobile connection down with an error that
  // points at the network rather than at a date.
  const { checkTls } = await import('../src/doctor.mjs');
  const now = Date.UTC(2026, 0, 1);
  const manifest = (days) => ({
    hosts: ['localhost'], ips: ['127.0.0.1'],
    notAfter: new Date(now + days * 86_400_000).toISOString(),
    fingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33'
  });

  const healthy = checkTls({ dir: '/x', hosts: ['localhost'], ips: ['127.0.0.1'], now, read: () => manifest(200) });
  assert.equal(healthy[0].status, OK);
  assert.match(healthy[0].detail, /200 more day/);

  const soon = checkTls({ dir: '/x', hosts: ['localhost'], ips: ['127.0.0.1'], now, read: () => manifest(5) });
  assert.equal(soon[0].status, NOTE);
  assert.match(soon[0].detail, /expires in 5 day/);

  const expired = checkTls({ dir: '/x', hosts: ['localhost'], ips: ['127.0.0.1'], now, read: () => manifest(-3) });
  assert.equal(expired[0].status, 'warn');
  assert.match(expired[0].detail, /expired 3 day\(s\) ago/);
});

test('a certificate that does not cover this machine says which address', async () => {
  // The common case: the laptop moved network since it was generated.
  const { checkTls } = await import('../src/doctor.mjs');
  const now = Date.UTC(2026, 0, 1);
  const checks = checkTls({
    dir: '/x',
    hosts: ['localhost'],
    ips: ['127.0.0.1', '10.0.0.7'],
    now,
    read: () => ({
      hosts: ['localhost'], ips: ['127.0.0.1', '192.168.1.42'],
      notAfter: new Date(now + 200 * 86_400_000).toISOString()
    })
  });

  const coverage = checks.find((c) => c.name === 'https coverage');
  assert.ok(coverage, 'a coverage gap is reported');
  assert.match(coverage.detail, /10\.0\.0\.7/);
  assert.match(coverage.detail, /regenerates on next start/, 'and says it fixes itself');
});

test('the fingerprint is shown short enough to compare by eye', async () => {
  const { checkTls } = await import('../src/doctor.mjs');
  const now = Date.UTC(2026, 0, 1);
  const checks = checkTls({
    dir: '/x', hosts: [], ips: [], now,
    read: () => ({
      hosts: [], ips: [],
      notAfter: new Date(now + 200 * 86_400_000).toISOString(),
      fingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55'
    })
  });
  const fingerprint = checks.find((c) => c.name === 'fingerprint');
  assert.equal(fingerprint.detail, 'AA:BB:CC:DD:EE:FF:00:11…');
});

test('doctor names a model that caches but has no cache rate (§28)', async () => {
  const { checkCacheRates } = await import('../src/doctor.mjs');
  const { Store, newId } = await import('../src/store.mjs');

  const store = new Store(':memory:');
  const run = store.createRun({ name: 'cached', source: 'gap' });
  const add = (model, read) => store.insertCall({
    id: newId(), run_id: run.id, seq: store.nextSeq(run.id),
    provider: 'anthropic', endpoint: '/v1/messages', model,
    started_at: Date.now(), input_tokens: 100, cache_read_tokens: read, request_json: '{}'
  });

  try {
    add('priced-model', 4000);
    add('input-only-model', 9000);

    const pricing = {
      rateFor: (model) => (model === 'priced-model'
        ? { in: 5, out: 25, cache_read: 0.5 }
        : model === 'input-only-model' ? { in: 3, out: 12 } : null)
    };

    const [check] = checkCacheRates(store, pricing);
    // This gap makes the bill look better than it was, which is the one
    // direction a cost estimate must never be wrong in silently.
    assert.equal(check.status, 'note');
    assert.match(check.detail, /input-only-model/);
    assert.equal(check.detail.includes('priced-model'), false);
  } finally {
    store.close();
  }
});

test('doctor says so when every cached model is priced', async () => {
  const { checkCacheRates } = await import('../src/doctor.mjs');
  const { Store, newId } = await import('../src/store.mjs');

  const store = new Store(':memory:');
  const run = store.createRun({ name: 'cached', source: 'gap' });
  try {
    store.insertCall({
      id: newId(), run_id: run.id, seq: store.nextSeq(run.id),
      provider: 'anthropic', endpoint: '/v1/messages', model: 'priced-model',
      started_at: Date.now(), input_tokens: 100, cache_read_tokens: 4000, request_json: '{}'
    });

    const pricing = { rateFor: () => ({ in: 5, out: 25, cache_read: 0.5 }) };
    const [check] = checkCacheRates(store, pricing);
    assert.equal(check.status, 'ok');
    assert.match(check.detail, /4,000 cached token/);
  } finally {
    store.close();
  }
});

test('a database with no caching at all produces no cache check', async () => {
  // Silence beats a green tick for something that never happened.
  const { checkCacheRates } = await import('../src/doctor.mjs');
  const { Store } = await import('../src/store.mjs');
  const store = new Store(':memory:');
  try {
    assert.deepEqual(checkCacheRates(store, { rateFor: () => null }), []);
  } finally {
    store.close();
  }
});
