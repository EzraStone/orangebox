// §23.2 — how many codewords a QR symbol holds, and how they are split.
//
// This file is transcription. Every number comes from the tables in ISO/IEC
// 18004, and a single digit wrong produces a symbol that is structurally
// perfect and scans as nothing.
//
// So none of it is trusted on sight. `totalCodewords()` derives the capacity of
// a version from its geometry — module count minus the function patterns —
// and the test asserts that every row below adds up to exactly that. A
// transcription error cannot survive both the table and the arithmetic.

/** Versions supported here. A pairing URL needs about 3; 10 is ample headroom. */
export const MAX_VERSION = 10;

export const EC_LEVELS = ['L', 'M', 'Q', 'H'];

/** Two bits each, and deliberately not in the order you would guess. */
export const EC_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

/**
 * [error-correction codewords per block, blocks in group 1, data codewords in
 * a group-1 block, blocks in group 2, data codewords in a group-2 block].
 *
 * Group 2 blocks, where present, hold exactly one codeword more than group 1.
 */
export const BLOCKS = {
  1:  { L: [7, 1, 19, 0, 0],    M: [10, 1, 16, 0, 0],   Q: [13, 1, 13, 0, 0],   H: [17, 1, 9, 0, 0] },
  2:  { L: [10, 1, 34, 0, 0],   M: [16, 1, 28, 0, 0],   Q: [22, 1, 22, 0, 0],   H: [28, 1, 16, 0, 0] },
  3:  { L: [15, 1, 55, 0, 0],   M: [26, 1, 44, 0, 0],   Q: [18, 2, 17, 0, 0],   H: [22, 2, 13, 0, 0] },
  4:  { L: [20, 1, 80, 0, 0],   M: [18, 2, 32, 0, 0],   Q: [26, 2, 24, 0, 0],   H: [16, 4, 9, 0, 0] },
  5:  { L: [26, 1, 108, 0, 0],  M: [24, 2, 43, 0, 0],   Q: [18, 2, 15, 2, 16],  H: [22, 2, 11, 2, 12] },
  6:  { L: [18, 2, 68, 0, 0],   M: [16, 4, 27, 0, 0],   Q: [24, 4, 19, 0, 0],   H: [28, 4, 15, 0, 0] },
  7:  { L: [20, 2, 78, 0, 0],   M: [18, 4, 31, 0, 0],   Q: [18, 2, 14, 4, 15],  H: [26, 4, 13, 1, 14] },
  8:  { L: [24, 2, 97, 0, 0],   M: [22, 2, 38, 2, 39],  Q: [22, 4, 18, 2, 19],  H: [26, 4, 14, 2, 15] },
  9:  { L: [30, 2, 116, 0, 0],  M: [22, 3, 36, 2, 37],  Q: [20, 4, 16, 4, 17],  H: [24, 4, 12, 4, 13] },
  10: { L: [18, 2, 68, 2, 69],  M: [26, 4, 43, 1, 44],  Q: [24, 6, 19, 2, 20],  H: [28, 6, 15, 2, 16] }
};

/** Side length in modules: 21 for version 1, then 4 more per version. */
export const sizeOf = (version) => 17 + 4 * version;

/**
 * Data modules available in a version, before error correction.
 *
 * Derived rather than tabulated: total area, minus the three finder patterns
 * and their separators, minus timing, minus alignment patterns (which overlap
 * timing in a way the formula accounts for), minus version information for
 * version 7 and above.
 */
export function rawDataModules(version) {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    modules -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) modules -= 36;
  }
  return modules;
}

/** Codewords in a version, all eight-bit. The remainder bits are not usable. */
export const totalCodewords = (version) => Math.floor(rawDataModules(version) / 8);

/** Data codewords available at a given version and error-correction level. */
export function dataCodewords(version, level) {
  const [ec, group1, data1, group2, data2] = blocksFor(version, level);
  void ec;
  return group1 * data1 + group2 * data2;
}

export function blocksFor(version, level) {
  const row = Object.hasOwn(BLOCKS, version) ? BLOCKS[version] : undefined;
  if (!row) throw new RangeError(`unsupported QR version: ${version}`);
  if (!Object.hasOwn(row, level)) throw new RangeError(`unknown error correction level: ${level}`);
  return row[level];
}

/**
 * The centre coordinates of the alignment patterns.
 *
 * Version 1 has none. Otherwise they sit at evenly spaced positions from 6 to
 * size-7, and the ones colliding with a finder pattern are dropped by the
 * caller rather than being missing from this list.
 */
export function alignmentCentres(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const last = sizeOf(version) - 7;
  // The step is rounded up to an even number, which is what makes the spacing
  // come out to the values in the standard's table.
  const step = Math.ceil((last - 6) / (count - 1) / 2) * 2;

  // Built from the far end inward, because the spacing is defined from the
  // last position backwards; 6 is always the first and is not part of that.
  const centres = [];
  for (let position = last; centres.length < count - 1; position -= step) centres.unshift(position);
  return [6, ...centres];
}

/**
 * The smallest version that fits `byteCount` in byte mode at this level, or
 * null if it does not fit at all.
 */
export function fitVersion(byteCount, level) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    // 4 bits of mode, then the character count: 8 bits below version 10, 16 at
    // version 10 and above for byte mode.
    const countBits = version < 10 ? 8 : 16;
    const needed = Math.ceil((4 + countBits) / 8) + byteCount;
    if (dataCodewords(version, level) >= needed) return version;
  }
  return null;
}
