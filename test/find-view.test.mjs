// §19.9 — the search view's text handling, without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitOnMatch, collapse, resultSummary } from '../ui/find.js';

test('a match is split out so it can be marked without building markup', () => {
  // The highlight is built by splitting the string and creating elements, not
  // by wrapping the match in tags inside a string. A recorded prompt is
  // untrusted text (§12.3) and must never be parsed as markup on its way in.
  const parts = splitOnMatch('the deploy failed', 'deploy');
  assert.deepEqual(parts, [
    { text: 'the ', match: false },
    { text: 'deploy', match: true },
    { text: ' failed', match: false }
  ]);
});

test('every occurrence is marked, not just the first', () => {
  const parts = splitOnMatch('lock, lock, lock', 'lock');
  assert.equal(parts.filter((p) => p.match).length, 3);
  assert.equal(parts.map((p) => p.text).join(''), 'lock, lock, lock');
});

test('matching ignores case but the original casing survives', () => {
  const parts = splitOnMatch('Kubernetes INGRESS here', 'ingress');
  const marked = parts.find((p) => p.match);
  assert.equal(marked.text, 'INGRESS', 'the text is shown as recorded, not as typed');
});

test('a match at either end does not produce empty fragments', () => {
  assert.deepEqual(splitOnMatch('abc', 'abc'), [{ text: 'abc', match: true }]);
  assert.deepEqual(splitOnMatch('abcd', 'abc'), [
    { text: 'abc', match: true },
    { text: 'd', match: false }
  ]);
  assert.deepEqual(splitOnMatch('dabc', 'abc'), [
    { text: 'd', match: false },
    { text: 'abc', match: true }
  ]);
});

test('splitting always reassembles into the original text', () => {
  // The property that matters: whatever the highlighting does, nothing is
  // dropped or duplicated on the way through.
  const cases = [
    ['', 'x'], ['no match here', 'zzz'], ['aaa', 'a'],
    ['markup <b>x</b> here', '<b>'], ['tail', ''], ['x', null]
  ];
  for (const [text, needle] of cases) {
    assert.equal(
      splitOnMatch(text, needle).map((p) => p.text).join(''),
      text,
      `lost text for ${JSON.stringify([text, needle])}`
    );
  }
});

test('collapse flattens JSON whitespace without eating letters', () => {
  const NL = String.fromCharCode(10);
  assert.equal(collapse(`{${NL}  "a":  1${NL}}`), '{ "a": 1 }');
  // The regression that made this its own function: a mangled whitespace
  // class deleted every letter s from the output.
  assert.equal(collapse('sessions passed successfully'), 'sessions passed successfully');
  assert.equal(collapse(null), '');
});

test('the summary says when results were truncated', () => {
  assert.equal(resultSummary(null), null);
  assert.equal(resultSummary({ query: '' }), null);
  assert.match(resultSummary({ query: 'x', total: 0 }), /Nothing recorded contains/);
  assert.equal(resultSummary({ query: 'x', total: 1, limit: 50 }), '1 match');
  assert.match(resultSummary({ query: 'x', total: 50, limit: 50 }), /showing the newest 50/);
});
