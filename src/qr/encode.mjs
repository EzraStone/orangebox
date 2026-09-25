// §23.3 — bytes to the final codeword sequence.
//
// Three steps, in this order: build a bit stream with a header, split it into
// blocks and give each its own error correction, then interleave the blocks.
//
// The interleaving is the part that looks gratuitous and is not. A QR symbol
// damaged by a thumb over one corner loses a contiguous run of modules; spread
// across blocks, that becomes a few errors in each block rather than a whole
// block destroyed, and a few errors per block is exactly what Reed-Solomon can
// repair.

import { remainder } from './galois.mjs';
import { blocksFor, dataCodewords, fitVersion } from './tables.mjs';

/** Byte mode. Numeric and alphanumeric modes pack tighter but a URL is neither. */
const MODE_BYTE = 0b0100;

/** Collects bits MSB-first into whole bytes. */
export class BitBuffer {
  constructor() {
    this.bits = [];
  }

  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
    return this;
  }

  get length() {
    return this.bits.length;
  }

  /** Pad to a byte boundary with zeros and return the bytes. */
  toBytes() {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, index) => {
      if (bit) bytes[index >>> 3] |= 0x80 >>> (index & 7);
    });
    return bytes;
  }
}

/**
 * The data codewords for a payload: header, bytes, terminator, padding.
 *
 * The pad bytes alternate 0xEC and 0x11. They are specified rather than chosen,
 * and using zeros instead produces a large blank region that confuses the
 * masking penalty and, in bad cases, real scanners.
 */
export function buildDataCodewords(bytes, version, level) {
  const capacity = dataCodewords(version, level);
  const countBits = version < 10 ? 8 : 16;
  const buffer = new BitBuffer();

  buffer.push(MODE_BYTE, 4);
  buffer.push(bytes.length, countBits);
  for (const byte of bytes) buffer.push(byte, 8);

  const capacityBits = capacity * 8;
  if (buffer.length > capacityBits) {
    throw new RangeError(`${bytes.length} bytes do not fit in version ${version}-${level}`);
  }

  // Terminator: up to four zero bits, fewer if the symbol is nearly full.
  buffer.push(0, Math.min(4, capacityBits - buffer.length));

  const codewords = new Uint8Array(capacity);
  codewords.set(buffer.toBytes());

  const used = Math.ceil(buffer.length / 8);
  for (let i = used; i < capacity; i++) {
    codewords[i] = (i - used) % 2 === 0 ? 0xec : 0x11;
  }
  return codewords;
}

/**
 * Split into blocks, compute each block's error correction, and interleave.
 *
 * Interleaving takes the first codeword of every block, then the second of
 * every block, and so on. Where blocks differ in length by one — which is why
 * group 2 exists — the short blocks simply have nothing to contribute on the
 * final pass.
 */
export function interleave(data, version, level) {
  const [ecPerBlock, group1, data1, group2, data2] = blocksFor(version, level);

  const blocks = [];
  let offset = 0;
  for (let i = 0; i < group1 + group2; i++) {
    const size = i < group1 ? data1 : data2;
    const block = data.subarray(offset, offset + size);
    offset += size;
    blocks.push({ data: block, ec: remainder(block, ecPerBlock) });
  }

  const out = [];
  const longest = Math.max(data1, data2 || 0);
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) {
      if (i < block.data.length) out.push(block.data[i]);
    }
  }
  // Error correction blocks are all the same length, so this pass is square.
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of blocks) out.push(block.ec[i]);
  }

  return Uint8Array.from(out);
}

/**
 * Everything before the matrix: pick a version, build codewords, interleave.
 */
export function encodeToCodewords(text, { level = 'M', version = null } = {}) {
  const bytes = Buffer.from(String(text), 'utf8');
  const chosen = version ?? fitVersion(bytes.length, level);

  if (chosen === null) {
    throw new RangeError(`${bytes.length} bytes is too large for a QR code at level ${level}`);
  }

  const data = buildDataCodewords(bytes, chosen, level);
  return { version: chosen, level, codewords: interleave(data, chosen, level), byteLength: bytes.length };
}
