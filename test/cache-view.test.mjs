// §28 — the wording of the caching line in the spend view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheNote } from '../ui/spend.js';

test('a window with no caching gets no line', () => {
  // "Caching saved $0" reads as a failure when it only means the feature was
  // never used, and a line on every window is a line people skip.
  assert.equal(cacheNote(null), null);
  assert.equal(cacheNote({ cached_tokens: 0, written_tokens: 0, net_usd: 0 }), null);
});

test('a saving is stated with the tokens behind it', () => {
  const text = cacheNote({ cached_tokens: 2_400_000, written_tokens: 0, net_usd: 4.2 });
  assert.match(text, /saved \$4\.20/);
  assert.match(text, /2\.4M tokens were read from cache/);
});

test('writes are named when there were any', () => {
  const text = cacheNote({ cached_tokens: 900_000, written_tokens: 120_000, net_usd: 1.5 });
  assert.match(text, /120k written to it/);
});

test('a cache that never paid off says so rather than showing a minus sign', () => {
  const text = cacheNote({ cached_tokens: 0, written_tokens: 500_000, net_usd: -0.75 });
  assert.match(text, /cost \$0\.750 more than it saved/);
  assert.equal(text.includes('-$'), false);
});

test('breaking even is its own answer', () => {
  const text = cacheNote({ cached_tokens: 1000, written_tokens: 1000, net_usd: 0 });
  assert.match(text, /broke even/);
});

test('unpriced cached calls are admitted rather than folded in', () => {
  const one = cacheNote({ cached_tokens: 1000, written_tokens: 0, net_usd: 0.01, unrated_calls: 1 });
  assert.match(one, /1 cached call had no rate/);

  const many = cacheNote({ cached_tokens: 1000, written_tokens: 0, net_usd: 0.01, unrated_calls: 4 });
  assert.match(many, /4 cached calls had no rate/);
});
