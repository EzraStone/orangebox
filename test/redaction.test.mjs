// §12.4 — user-defined redaction of recorded prompts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRedactionRules } from '../src/store.mjs';
import { compileRedactionRules } from '../src/config.mjs';

const compile = (patterns) => compileRedactionRules(
  patterns.map((p) => (typeof p === 'string' ? { pattern: p, replacement: '[redacted]', flags: 'g' } : p))
).rules;

test('a pattern is scrubbed from every string in the payload', () => {
  // A character class, deliberately free of backslashes: this file has lost
  // them in transit before, and a mangled pattern silently matches nothing.
  const rules = compile(['[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+[.][a-zA-Z]{2,}']);
  const { value } = applyRedactionRules(
    { messages: [{ role: 'user', content: 'email ada@example.com about it' }] },
    rules
  );
  assert.equal(value.messages[0].content, 'email [redacted] about it');
});

test('every occurrence goes, not just the first', () => {
  // A rule that scrubs the first instance of a secret has not scrubbed it.
  const rules = compile(['secret']);
  const { value } = applyRedactionRules({ a: 'secret and secret and secret' }, rules);
  assert.equal(value.a, '[redacted] and [redacted] and [redacted]');
});

test('a reused rule keeps working on the next payload', () => {
  // A /g regex remembers lastIndex between calls. Without resetting it, every
  // other recorded call would go unscrubbed — which is the kind of bug that
  // looks like it works when you test it once.
  const rules = compile(['token']);
  for (let i = 0; i < 5; i++) {
    const { value } = applyRedactionRules({ a: 'token here' }, rules);
    assert.equal(value.a, '[redacted] here', `call ${i} was not scrubbed`);
  }
});

test('object keys are left alone', () => {
  // Renaming a field changes the shape of the record. A prompt whose structure
  // silently changed is worse to debug than one with a visible placeholder.
  const rules = compile(['secret']);
  const { value } = applyRedactionRules({ secret: 'secret' }, rules);
  assert.deepEqual(Object.keys(value), ['secret']);
  assert.equal(value.secret, '[redacted]');
});

test('non-strings pass through untouched', () => {
  const rules = compile(['1']);
  const { value } = applyRedactionRules({ n: 1, b: true, z: null, arr: [1, 2] }, rules);
  assert.deepEqual(value, { n: 1, b: true, z: null, arr: [1, 2] });
});

test('hits are counted per rule so the UI can say it fired', () => {
  const rules = compileRedactionRules([
    { pattern: 'alpha', replacement: '[a]', flags: 'g', label: 'alphas' },
    { pattern: 'beta', replacement: '[b]', flags: 'g', label: 'betas' }
  ]).rules;

  const { hits } = applyRedactionRules({ x: 'alpha alpha beta' }, rules);
  assert.equal(hits.alphas, 2);
  assert.equal(hits.betas, 1);
});

test('no rules means the payload is returned unchanged, identically', () => {
  const payload = { messages: [{ content: 'anything at all' }] };
  const { value, hits } = applyRedactionRules(payload, []);
  assert.equal(value, payload, 'the same object, not a copy');
  assert.deepEqual(hits, {});
});

test('a pattern that cannot compile is reported, not thrown', () => {
  const { rules, errors } = compileRedactionRules([
    { pattern: '(unclosed', replacement: 'x', flags: 'g' },
    { pattern: 'fine', replacement: 'x', flags: 'g' }
  ]);
  assert.equal(rules.length, 1, 'the valid rule survives');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not a valid regular expression/);
});

test('the g flag is forced on even if the user omits it', () => {
  const { rules } = compileRedactionRules([{ pattern: 'x', flags: 'i' }]);
  assert.ok(rules[0].regex.flags.includes('g'));
  assert.ok(rules[0].regex.flags.includes('i'));
});

test('nested content is reached at any depth', () => {
  const rules = compile(['deep']);
  const { value } = applyRedactionRules(
    { a: [{ b: { c: [{ d: 'a deep secret' }] } }] },
    rules
  );
  assert.equal(value.a[0].b.c[0].d, 'a [redacted] secret');
});

test('a rule scrubs a real proxied call before it reaches disk (§12.4)', async () => {
  const { startOrangebox, startMockUpstream, jsonResponse, settle, removeTempDir } =
    await import('./helpers.mjs');
  const fs = await import('node:fs');

  const { rules } = compileRedactionRules([
    { pattern: 'ACCT-[0-9]{6}', replacement: '[account]', flags: 'g', label: 'accounts' }
  ]);

  const upstream = await startMockUpstream((req, res) =>
    jsonResponse(res, 200, {
      model: 'claude-opus-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'text', text: 'I looked up ACCT-999888 for you' }]
    })
  );
  const app = await startOrangebox({
    providers: { anthropic: upstream.origin, openai: upstream.origin },
    redactionRules: rules
  });

  try {
    const res = await fetch(`${app.origin}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'look up ACCT-123456 please' }]
      })
    });
    const relayed = await res.text();

    // The agent still receives the real thing: redaction is about what is
    // stored, never about what is forwarded.
    assert.match(relayed, /ACCT-999888/, 'the upstream response must reach the client intact');

    assert.ok(await settle(app, () => app.store.countRuns() === 1));
    const runId = app.store.listRuns().runs[0].id;
    const call = app.store.fullCalls(runId)[0];

    assert.match(call.request_json, /\[account\]/);
    assert.doesNotMatch(call.request_json, /ACCT-123456/, 'the prompt account number was stored');
    assert.doesNotMatch(call.response_json, /ACCT-999888/, 'the response account number was stored');

    // And nowhere in the file either.
    const raw = fs.readFileSync(app.dbPath);
    assert.equal(raw.includes('ACCT-123456'), false, 'the account number survived into the database file');
    assert.equal(raw.includes('ACCT-999888'), false, 'the response account number survived into the file');

    // The record says it was altered. The count covers the whole call — one
    // hit in the prompt and one in the response — since it exists to tell a
    // reader this record is not verbatim, not to locate the hits.
    const stored = JSON.parse(call.request_json);
    assert.equal(stored._orangebox.redacted.accounts, 2);
  } finally {
    await app.close();
    await upstream.close();
    removeTempDir(app.dbPath);
  }
});
