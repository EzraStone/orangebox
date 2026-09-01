// §19.9 — searching inside recorded prompts and responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, newId, snippetAround, likeLiteral } from '../src/store.mjs';

function withCalls(payloads) {
  const store = new Store(':memory:');
  const run = store.createRun({ name: 'search run', source: 'gap' });
  payloads.forEach((p, i) => {
    store.insertCall({
      id: newId(), run_id: run.id, seq: store.nextSeq(run.id),
      provider: 'anthropic', endpoint: '/v1/messages', model: 'claude-opus-5',
      started_at: 1_000_000 + i * 1000,
      request_json: JSON.stringify(p.request ?? {}),
      response_json: p.response === undefined ? null : JSON.stringify(p.response)
    });
  });
  return store;
}

test('a phrase in a prompt is found, and says where it matched', () => {
  const store = withCalls([
    { request: { messages: [{ role: 'user', content: 'deploy the staging cluster' }] } },
    { request: { messages: [{ role: 'user', content: 'something else entirely' }] } }
  ]);

  const found = store.searchCalls({ query: 'staging cluster' });
  assert.equal(found.total, 1);
  assert.equal(found.results[0].where, 'request');
  assert.match(found.results[0].snippet, /staging cluster/);
  assert.equal(found.results[0].run_name, 'search run');
  store.close();
});

test('a phrase in a response is found too, and both is reported as both', () => {
  const store = withCalls([
    { request: { messages: [] }, response: { content: [{ text: 'the migration lock was held' }] } },
    { request: { note: 'lock' }, response: { content: [{ text: 'lock' }] } }
  ]);

  assert.equal(store.searchCalls({ query: 'migration lock' }).results[0].where, 'response');
  assert.equal(store.searchCalls({ query: 'lock' }).results.find((r) => r.where === 'both') !== undefined, true);
  store.close();
});

test('matching is case-insensitive, the way people type', () => {
  const store = withCalls([{ request: { messages: [{ content: 'Kubernetes Ingress' }] } }]);
  assert.equal(store.searchCalls({ query: 'kubernetes ingress' }).total, 1);
  assert.equal(store.searchCalls({ query: 'KUBERNETES' }).total, 1);
  store.close();
});

test('LIKE metacharacters are searched for literally (§19.9)', () => {
  // Without escaping, "%" matches everything and "_" matches any character, so
  // a search for "100%" would return every call in the database and look like
  // a working search rather than a broken one.
  const store = withCalls([
    { request: { messages: [{ content: 'coverage hit 100% today' }] } },
    { request: { messages: [{ content: 'nothing relevant here' }] } },
    { request: { messages: [{ content: 'snake_case identifier' }] } },
    { request: { messages: [{ content: 'snakeXcase identifier' }] } }
  ]);

  const percent = store.searchCalls({ query: '100%' });
  assert.equal(percent.total, 1, '% must not act as a wildcard');

  const underscore = store.searchCalls({ query: 'snake_case' });
  assert.equal(underscore.total, 1, '_ must not match any character');
  assert.match(underscore.results[0].snippet, /snake_case/);

  // A bare wildcard is a literal too: it finds the one row that actually
  // contains a percent sign, not all four.
  assert.equal(store.searchCalls({ query: '%' }).total, 1);
  store.close();
});

test('an empty query returns nothing rather than the whole database', () => {
  const store = withCalls([{ request: { messages: [{ content: 'anything' }] } }]);
  for (const query of ['', '   ', null, undefined]) {
    assert.equal(store.searchCalls({ query }).total, 0, `"${query}" should match nothing`);
  }
  store.close();
});

test('results are capped, and the cap cannot be raised without limit', () => {
  const store = withCalls(
    Array.from({ length: 30 }, () => ({ request: { messages: [{ content: 'repeated needle' }] } }))
  );
  assert.equal(store.searchCalls({ query: 'needle', limit: 5 }).total, 5);
  assert.equal(store.searchCalls({ query: 'needle', limit: 10_000 }).results.length, 30);
  assert.equal(store.searchCalls({ query: 'needle', limit: 0 }).total, 1, 'a zero limit still returns one');
  store.close();
});

test('newest matches come first', () => {
  const store = withCalls([
    { request: { messages: [{ content: 'needle one' }] } },
    { request: { messages: [{ content: 'needle two' }] } },
    { request: { messages: [{ content: 'needle three' }] } }
  ]);
  const seqs = store.searchCalls({ query: 'needle' }).results.map((r) => r.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a));
  store.close();
});

test('a window narrows the search', () => {
  const store = withCalls([
    { request: { messages: [{ content: 'needle' }] } },
    { request: { messages: [{ content: 'needle' }] } }
  ]);
  assert.equal(store.searchCalls({ query: 'needle' }).total, 2);
  assert.equal(store.searchCalls({ query: 'needle', since: 1_000_500 }).total, 1);
  store.close();
});

test('a call with no response is searchable on its request alone', () => {
  // Errored and aborted calls have a null response_json, and they are often
  // exactly the ones being looked for.
  const store = withCalls([{ request: { messages: [{ content: 'find me' }] }, response: undefined }]);
  const found = store.searchCalls({ query: 'find me' });
  assert.equal(found.total, 1);
  assert.equal(found.results[0].where, 'request');
  store.close();
});

test('likeLiteral escapes every LIKE metacharacter, backslash included', () => {
  const BS = String.fromCharCode(92);
  assert.equal(likeLiteral('plain'), 'plain');
  assert.equal(likeLiteral('100%'), '100' + BS + '%');
  assert.equal(likeLiteral('snake_case'), 'snake' + BS + '_case');
  // The escape character itself has to be escaped first, or escaping % would
  // produce a backslash that then escapes the wrong thing.
  assert.equal(likeLiteral(BS), BS + BS);
  assert.equal(likeLiteral(BS + '%'), BS + BS + BS + '%');
  assert.equal(likeLiteral(null), '');
});

test('a snippet centres on the hit and marks where it was cut', () => {
  const text = 'x'.repeat(200) + 'NEEDLE' + 'y'.repeat(200);
  const snippet = snippetAround(text, 'needle', 40);

  assert.match(snippet, /NEEDLE/, 'keeps the original casing of the text');
  assert.ok(snippet.startsWith('…'), 'marks the cut at the start');
  assert.ok(snippet.endsWith('…'), 'marks the cut at the end');
  assert.ok(snippet.length < 80, `snippet was ${snippet.length} chars`);
});

test('a short text is returned whole, with no ellipses', () => {
  const snippet = snippetAround('deploy failed', 'failed', 160);
  assert.equal(snippet, 'deploy failed');
});

test('a snippet of a blob that does not contain the needle is null', () => {
  // The row matched on the other column; there is nothing to show from this one.
  assert.equal(snippetAround('nothing here', 'needle'), null);
  assert.equal(snippetAround(null, 'needle'), null);
  assert.equal(snippetAround('', 'needle'), null);
});
