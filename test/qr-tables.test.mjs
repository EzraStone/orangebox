// §23.2 — QR capacity and block structure.
//
// This file exists because tables.mjs is transcription, and one wrong digit
// produces a symbol that is structurally perfect and scans as nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKS, EC_LEVELS, MAX_VERSION, sizeOf, rawDataModules, totalCodewords,
  dataCodewords, blocksFor, alignmentCentres, fitVersion
} from '../src/qr/tables.mjs';

test('every block row adds up to the capacity derived from geometry (§23.2)', () => {
  // The important test. The capacity comes from module count minus function
  // patterns — arithmetic, not transcription — so a typo in the table cannot
  // survive both.
  for (let version = 1; version <= MAX_VERSION; version++) {
    const capacity = totalCodewords(version);
    for (const level of EC_LEVELS) {
      const [ec, group1, data1, group2, data2] = blocksFor(version, level);
      const total = ec * (group1 + group2) + group1 * data1 + group2 * data2;
      assert.equal(total, capacity, `version ${version}-${level}: ${total} codewords, capacity is ${capacity}`);
    }
  }
});

test('capacities match the published totals for the versions we support', () => {
  // A second, independent check on the formula itself.
  const published = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346 };
  for (const [version, total] of Object.entries(published)) {
    assert.equal(totalCodewords(Number(version)), total, `version ${version}`);
  }
});

test('group 2 blocks hold exactly one codeword more than group 1', () => {
  // A structural rule of the standard. Anywhere it does not hold, the table is
  // wrong even if the totals happen to add up.
  for (let version = 1; version <= MAX_VERSION; version++) {
    for (const level of EC_LEVELS) {
      const [, , data1, group2, data2] = blocksFor(version, level);
      if (group2 > 0) {
        assert.equal(data2, data1 + 1, `version ${version}-${level}`);
      }
    }
  }
});

test('more error correction always means less room for data', () => {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const sizes = EC_LEVELS.map((level) => dataCodewords(version, level));
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(sizes[i] < sizes[i - 1], `version ${version}: ${EC_LEVELS[i]} is not smaller than ${EC_LEVELS[i - 1]}`);
    }
  }
});

test('symbol size is 21 modules at version 1 and grows by four', () => {
  assert.equal(sizeOf(1), 21);
  assert.equal(sizeOf(2), 25);
  assert.equal(sizeOf(10), 57);
});

test('alignment pattern centres match the standard', () => {
  // Published positions. Getting these wrong misplaces a function pattern,
  // which corrupts the data placed around it.
  assert.deepEqual(alignmentCentres(1), [], 'version 1 has none');
  assert.deepEqual(alignmentCentres(2), [6, 18]);
  assert.deepEqual(alignmentCentres(6), [6, 34]);
  assert.deepEqual(alignmentCentres(7), [6, 22, 38]);
  assert.deepEqual(alignmentCentres(8), [6, 24, 42]);
  assert.deepEqual(alignmentCentres(9), [6, 26, 46]);
  assert.deepEqual(alignmentCentres(10), [6, 28, 50]);
});

test('alignment centres stay inside the symbol', () => {
  for (let version = 2; version <= MAX_VERSION; version++) {
    const size = sizeOf(version);
    for (const centre of alignmentCentres(version)) {
      assert.ok(centre >= 6 && centre <= size - 7, `version ${version}: centre ${centre} out of range`);
    }
  }
});

test('version selection picks the smallest that fits', () => {
  // Version 1-M holds 16 data codewords, and the 12-bit header costs two of
  // them, so 14 bytes is the real limit — not 16, which is the trap.
  assert.equal(fitVersion(10, 'M'), 1);
  assert.equal(fitVersion(14, 'M'), 1, 'the true version 1-M limit');
  assert.equal(fitVersion(15, 'M'), 2, 'one byte more needs the next version');

  // A pairing URL is around 45 bytes.
  assert.equal(fitVersion(45, 'M'), 4);
  assert.equal(fitVersion(45, 'L'), 3, 'less error correction fits it smaller');
});

test('something too large for the supported versions returns null', () => {
  // Better than silently truncating the payload into a scannable but wrong code.
  assert.equal(fitVersion(100_000, 'L'), null);
  assert.equal(fitVersion(dataCodewords(MAX_VERSION, 'L'), 'L'), null, 'no room left for the header');
});

test('an unknown version or level is refused by name', () => {
  assert.throws(() => blocksFor(99, 'M'), /unsupported QR version/);
  assert.throws(() => blocksFor(1, 'Z'), /unknown error correction level/);
  // Prototype keys must not resolve, same lesson as everywhere else here.
  assert.throws(() => blocksFor('constructor', 'M'), /unsupported QR version/);
  assert.throws(() => blocksFor(1, 'toString'), /unknown error correction level/);
});

test('raw module counts leave room for the remainder bits', () => {
  // Most versions have a few bits left over that no codeword uses. They must
  // be left over, not rounded into a codeword that does not exist.
  for (let version = 1; version <= MAX_VERSION; version++) {
    const leftover = rawDataModules(version) - totalCodewords(version) * 8;
    assert.ok(leftover >= 0 && leftover < 8, `version ${version} has ${leftover} spare bits`);
  }
});
