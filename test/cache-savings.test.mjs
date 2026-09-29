// §28 — what prompt caching did to the bill.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPricing, cacheSavings } from '../src/pricing.mjs';
import { Store, newId } from '../src/store.mjs';

const pricing = loadPricing({ userFile: null });

test('a cache read saves the difference between the two rates', () => {
  const rate = pricing.rateFor('claude-opus-5');
  const result = cacheSavings([{ model: 'claude-opus-5', calls: 1, cache_read_tokens: 1_000_000 }], pricing);

  assert.equal(result.cached_tokens, 1_000_000);
  assert.ok(Math.abs(result.saved_usd - (rate.in - rate.cache_read)) < 1e-6);
});

test('a cache write is reported as the cost it is, not as a saving', () => {
  // Writes cost more than ordinary input — 1.25x on most providers. Reporting
  // only the saving would make every cache look free, which is exactly the
  // claim somebody would go and check.
  const rate = pricing.rateFor('claude-opus-5');
  const result = cacheSavings([{ model: 'claude-opus-5', calls: 1, cache_write_tokens: 1_000_000 }], pricing);

  assert.equal(result.saved_usd, 0);
  assert.ok(Math.abs(result.write_premium_usd - (rate.cache_write - rate.in)) < 1e-6);
  assert.ok(result.net_usd < 0, 'a write with no reads after it is money lost');
});

test('reads and writes net off against each other', () => {
  const result = cacheSavings([
    { model: 'claude-opus-5', calls: 20, cache_read_tokens: 4_000_000, cache_write_tokens: 200_000 }
  ], pricing);

  assert.ok(result.net_usd > 0, 'four million cached reads pay for one write many times over');
  assert.ok(Math.abs(result.net_usd - (result.saved_usd - result.write_premium_usd)) < 1e-9);
});

test('an unpriced model is counted, never assumed free', () => {
  const result = cacheSavings([{ model: 'some-model-nobody-priced', calls: 3, cache_read_tokens: 500 }], pricing);
  assert.equal(result.saved_usd, 0);
  assert.equal(result.cached_tokens, 0);
  assert.equal(result.unrated_calls, 3);
});

test('a model with no separate cache rate saves nothing rather than everything', () => {
  // Falling back to zero for a missing cache_read rate would report the entire
  // input cost as a saving.
  const fake = { rateFor: () => ({ in: 5, out: 25 }) };
  const result = cacheSavings([{ model: 'x', calls: 1, cache_read_tokens: 1_000_000 }], fake);
  assert.equal(result.saved_usd, 0);
});

test('cacheUsage rolls cached tokens up by model', () => {
  const store = new Store(':memory:');
  const run = store.createRun({ name: 'cached', source: 'gap' });
  const add = (model, read, write) => store.insertCall({
    id: newId(), run_id: run.id, seq: store.nextSeq(run.id),
    provider: 'anthropic', endpoint: '/v1/messages', model,
    started_at: Date.now(), input_tokens: 100, output_tokens: 10,
    cache_read_tokens: read, cache_write_tokens: write, request_json: '{}'
  });

  add('claude-opus-5', 5000, 0);
  add('claude-opus-5', 3000, 1200);
  add('gpt-5.6-sol', 900, null);
  // A call with no cache accounting at all must not create a row of zeroes.
  add('llama3.2', null, null);

  const rows = store.cacheUsage();
  const byModel = Object.fromEntries(rows.map((r) => [r.model, r]));

  assert.equal(rows.length, 2, 'only models that reported cache counts');
  assert.equal(byModel['claude-opus-5'].cache_read_tokens, 8000);
  assert.equal(byModel['claude-opus-5'].cache_write_tokens, 1200);
  assert.equal(byModel['gpt-5.6-sol'].cache_read_tokens, 900);
  store.close();
});

test('spend carries the cached token counts alongside the cost', () => {
  const store = new Store(':memory:');
  const run = store.createRun({ name: 'cached', source: 'gap' });
  store.insertCall({
    id: newId(), run_id: run.id, seq: store.nextSeq(run.id),
    provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
    started_at: Date.now(), input_tokens: 400, output_tokens: 20,
    cache_read_tokens: 7000, cache_write_tokens: 500, cost_usd: 0.01, request_json: '{}'
  });

  const [group] = store.spend({ groupBy: 'model' }).groups;
  assert.equal(group.cache_read_tokens, 7000);
  assert.equal(group.cache_write_tokens, 500);
  store.close();
});

test('GET /api/spend reports what caching did', async () => {
  const { startOrangebox, removeTempDir } = await import('./helpers.mjs');
  const app = await startOrangebox({});

  try {
    const run = app.store.createRun({ name: 'cached', source: 'gap' });
    app.store.insertCall({
      id: newId(), run_id: run.id, seq: app.store.nextSeq(run.id),
      provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
      started_at: Date.now(), input_tokens: 500, output_tokens: 30,
      cache_read_tokens: 1_000_000, cost_usd: 0.5, request_json: '{}'
    });

    const body = await (await fetch(`${app.origin}/api/spend`)).json();
    assert.ok(body.cache, 'spend should carry a cache block');
    assert.equal(body.cache.cached_tokens, 1_000_000);
    assert.ok(body.cache.saved_usd > 0);
  } finally {
    await app.close();
    removeTempDir(app.dbPath);
  }
});

test('a database with no caching at all reports zeroes, not a missing block', async () => {
  const { startOrangebox, removeTempDir } = await import('./helpers.mjs');
  const app = await startOrangebox({});
  try {
    const body = await (await fetch(`${app.origin}/api/spend`)).json();
    assert.equal(body.cache.cached_tokens, 0);
    assert.equal(body.cache.net_usd, 0);
  } finally {
    await app.close();
    removeTempDir(app.dbPath);
  }
});
