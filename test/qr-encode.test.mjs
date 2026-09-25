// §23.3 — payload to codewords.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BitBuffer, buildDataCodewords, interleave, encodeToCodewords } from '../src/qr/encode.mjs';
import { blocksFor, dataCodewords, totalCodewords, EC_LEVELS, MAX_VERSION } from '../src/qr/tables.mjs';

test('the bit buffer packs MSB-first', () => {
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4).push(0b00000101, 8);
  assert.equal(buffer.length, 12);
  // 0100 0000 0101 -> 0x40, 0x5(0 padded)
  assert.deepEqual([...buffer.toBytes()], [0x40, 0x50]);
});

test('a known payload encodes to the bits the standard describes', () => {
  // "HELLO" at version 1-M, worked through by hand: mode 0100, count 00000101,
  // then the five bytes, then a terminator — which shifts every character 12
  // bits out of alignment, so the codewords are not the ASCII you would expect.
  const codewords = buildDataCodewords(Buffer.from('HELLO'), 1, 'M');

  assert.equal(codewords.length, 16, 'version 1-M holds 16 data codewords');
  assert.deepEqual(
    [...codewords.subarray(0, 7)],
    [0x40, 0x54, 0x84, 0x54, 0xc4, 0xc4, 0xf0]
  );
});

test('padding uses the two bytes the standard names, alternating', () => {
  // Zeros instead would leave a large blank region that confuses the masking
  // penalty and, in bad cases, real scanners.
  const codewords = buildDataCodewords(Buffer.from('HI'), 1, 'M');
  const padding = [...codewords.subarray(4)];
  assert.deepEqual(padding, [0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
});

test('data codewords always fill the capacity exactly', () => {
  for (let version = 1; version <= MAX_VERSION; version++) {
    for (const level of EC_LEVELS) {
      const codewords = buildDataCodewords(Buffer.from('x'), version, level);
      assert.equal(codewords.length, dataCodewords(version, level), `version ${version}-${level}`);
    }
  }
});

test('a payload larger than the version is refused, not truncated', () => {
  // Truncating would produce a scannable code containing the wrong thing,
  // which is far worse than refusing.
  assert.throws(() => buildDataCodewords(Buffer.alloc(100), 1, 'M'), /do not fit/);
  assert.throws(() => encodeToCodewords('x'.repeat(100_000)), /too large for a QR code/);
});

test('interleaving produces exactly the symbol capacity', () => {
  for (let version = 1; version <= MAX_VERSION; version++) {
    for (const level of EC_LEVELS) {
      const data = buildDataCodewords(Buffer.from('payload'), version, level);
      const interleaved = interleave(data, version, level);
      assert.equal(interleaved.length, totalCodewords(version), `version ${version}-${level}`);
    }
  }
});

test('interleaving is reversible, so nothing is lost or duplicated', () => {
  // The transform exists so that damage to one region of the symbol becomes a
  // few errors in every block rather than one block destroyed. It has to be a
  // permutation, not a rearrangement that drops a codeword at the seams.
  const version = 5;
  const level = 'Q'; // two groups of different sizes: the case that gets this wrong
  const [ecPerBlock, group1, data1, group2, data2] = blocksFor(version, level);

  const data = Uint8Array.from({ length: dataCodewords(version, level) }, (_, i) => (i + 1) & 0xff);
  const interleaved = interleave(data, version, level);

  // Rebuild the data half by walking the same order.
  const sizes = [...Array(group1).fill(data1), ...Array(group2).fill(data2)];
  const blocks = sizes.map(() => []);
  let index = 0;
  for (let i = 0; i < Math.max(...sizes); i++) {
    for (let b = 0; b < sizes.length; b++) {
      if (i < sizes[b]) blocks[b].push(interleaved[index++]);
    }
  }

  assert.deepEqual([...blocks.flat()], [...data], 'de-interleaving did not return the original');
  assert.equal(interleaved.length - index, ecPerBlock * sizes.length, 'the rest is error correction');
});

test('a version is chosen automatically and can be forced', () => {
  const auto = encodeToCodewords('https://192.168.1.42:4100/#pair=ABCD1234', { level: 'M' });
  assert.equal(auto.version, 3);
  assert.equal(auto.byteLength, 40);
  assert.equal(auto.codewords.length, totalCodewords(3));

  const forced = encodeToCodewords('short', { level: 'M', version: 7 });
  assert.equal(forced.version, 7);
  assert.equal(forced.codewords.length, totalCodewords(7));
});

test('utf-8 is measured in bytes, not characters', () => {
  // A character count would under-estimate and produce a version too small,
  // which fails late and confusingly.
  const result = encodeToCodewords('café — ☕', { level: 'M' });
  assert.equal(result.byteLength, Buffer.from('café — ☕', 'utf8').length);
  assert.ok(result.byteLength > 8, 'multi-byte characters counted as bytes');
});

test('an empty payload still produces a valid symbol', () => {
  const result = encodeToCodewords('', { level: 'M' });
  assert.equal(result.version, 1);
  assert.equal(result.codewords.length, totalCodewords(1));
});
