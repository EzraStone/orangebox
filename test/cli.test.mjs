// §10 — the CLI's formatting helpers. Small, but they are the layer where a
// recorded name written by somebody else meets a file somebody else parses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, truncate } from '../src/cli.mjs';

test('plain values go through the csv unquoted', () => {
  assert.equal(csvCell('claude-opus-5'), 'claude-opus-5');
  assert.equal(csvCell(42), '42');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});

test('a run name with a comma cannot shift the columns', () => {
  // Run names are typed by whoever started the run. "checkout, retry path" is
  // a perfectly reasonable name and an unquoted one silently adds a column.
  assert.equal(csvCell('checkout, retry path'), '"checkout, retry path"');
});

test('quotes in a name are doubled, per RFC 4180', () => {
  assert.equal(csvCell('the "fast" agent'), '"the ""fast"" agent"');
  assert.equal(csvCell('",injected'), '""",injected"');
});

test('a newline in a name cannot forge a new row', () => {
  // The nastier version of the comma case: an unquoted newline ends the record
  // and everything after it parses as a separate row of data.
  const LF = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  assert.equal(csvCell('night run' + LF + 'fake,row,here'), '"night run' + LF + 'fake,row,here"');
  assert.equal(csvCell('a' + CR + 'b'), '"a' + CR + 'b"');
});

test('a quoted cell round-trips back to the original text', () => {
  // Parse it back the way a spreadsheet would and check nothing was lost.
  const unwrap = (cell) =>
    cell.startsWith('"') ? cell.slice(1, -1).split('""').join('"') : cell;

  const LF = String.fromCharCode(10);
  for (const original of ['plain', 'has, comma', 'has "quotes"', 'has' + LF + 'newline', '"', ',,,']) {
    assert.equal(unwrap(csvCell(original)), original, `round-trip failed for ${JSON.stringify(original)}`);
  }
});

test('long keys are ellipsised to the column width', () => {
  assert.equal(truncate('short', 20), 'short');
  const out = truncate('claude-opus-4-5-20250929-experimental', 20);
  assert.equal(out.length, 20);
  assert.ok(out.endsWith('\u2026'));
});
