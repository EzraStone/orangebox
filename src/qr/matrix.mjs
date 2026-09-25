// §23.4 — laying codewords out as modules.
//
// A QR symbol is mostly structure. The finder patterns, timing lines and
// alignment patterns are fixed by the version and carry no data; everything
// else is filled with the codeword bits in a zigzag from the bottom right,
// then XORed with whichever of eight masks leaves the symbol easiest to scan.
//
// The masking is not cosmetic. An unmasked symbol can contain large blank
// regions, or accidental copies of the finder pattern, and both defeat real
// scanners — so all eight are tried and scored, which is what the standard
// requires rather than an optimisation.

import { sizeOf, alignmentCentres, EC_BITS } from './tables.mjs';

const LIGHT = 0;
const DARK = 1;

/** A symbol being built: the modules, and which of them are structural. */
export class Matrix {
  constructor(version) {
    this.version = version;
    this.size = sizeOf(version);
    this.modules = Array.from({ length: this.size }, () => new Uint8Array(this.size));
    // Function modules must not be overwritten by data, and must not be masked.
    this.reserved = Array.from({ length: this.size }, () => new Uint8Array(this.size));
  }

  set(row, col, value, { reserve = false } = {}) {
    if (row < 0 || col < 0 || row >= this.size || col >= this.size) return;
    this.modules[row][col] = value ? DARK : LIGHT;
    if (reserve) this.reserved[row][col] = 1;
  }

  get(row, col) {
    return this.modules[row][col];
  }

  isReserved(row, col) {
    return this.reserved[row][col] === 1;
  }

  /** Rows of 0/1, which is all any renderer needs. */
  toRows() {
    return this.modules.map((row) => Array.from(row));
  }
}

/** The 7x7 concentric square, with its one-module light separator. */
function placeFinder(matrix, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const ring = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
      matrix.set(row + r, col + c, inner || ring, { reserve: true });
    }
  }
}

/** The 5x5 alignment pattern: a dark ring around a light ring around a dot. */
function placeAlignment(matrix, row, col) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const distance = Math.max(Math.abs(r), Math.abs(c));
      matrix.set(row + r, col + c, distance !== 1, { reserve: true });
    }
  }
}

/**
 * Everything that is not data: finders, timing, alignment, the dark module,
 * and the areas format and version information will occupy.
 */
export function placeFunctionPatterns(matrix) {
  const { size } = matrix;

  placeFinder(matrix, 0, 0);
  placeFinder(matrix, 0, size - 7);
  placeFinder(matrix, size - 7, 0);

  // Timing: alternating modules along row and column 6, between the finders.
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    matrix.set(6, i, dark, { reserve: true });
    matrix.set(i, 6, dark, { reserve: true });
  }

  // Alignment patterns, except where they would sit on a finder.
  const centres = alignmentCentres(matrix.version);
  for (const row of centres) {
    for (const col of centres) {
      const onFinder =
        (row === 6 && col === 6) ||
        (row === 6 && col === size - 7) ||
        (row === size - 7 && col === 6);
      if (!onFinder) placeAlignment(matrix, row, col);
    }
  }

  // The dark module: always set, always here, no reason given by the standard.
  matrix.set(size - 8, 8, DARK, { reserve: true });

  // Reserve the format information areas so data placement skips them.
  //
  // Index 6 is excluded in both directions: that is where the timing pattern
  // crosses, and the format bits step over it. Reserving it here blanked two
  // timing modules, which a round-trip test cannot catch — the decoder reads
  // the same map the encoder wrote, so both agree on the damage.
  for (let i = 0; i < 9; i++) {
    if (i !== 6) matrix.set(8, i, LIGHT, { reserve: true });
    if (i !== 6) matrix.set(i, 8, LIGHT, { reserve: true });
  }
  for (let i = 0; i < 8; i++) {
    matrix.set(8, size - 1 - i, LIGHT, { reserve: true });
    matrix.set(size - 1 - i, 8, LIGHT, { reserve: true });
  }

  // Version information, for symbols large enough to need it.
  if (matrix.version >= 7) {
    for (let i = 0; i < 18; i++) {
      const row = Math.floor(i / 3);
      const col = size - 11 + (i % 3);
      matrix.set(row, col, LIGHT, { reserve: true });
      matrix.set(col, row, LIGHT, { reserve: true });
    }
  }
}

/**
 * Fill the data modules with the codeword bits.
 *
 * Two-module-wide columns, right to left, alternating upward and downward.
 * Column 6 is skipped entirely — it is the vertical timing pattern, and a
 * strip that included it would be one module narrower than the algorithm
 * assumes and put every subsequent bit in the wrong place.
 */
export function placeCodewords(matrix, codewords) {
  const { size } = matrix;
  let bitIndex = 0;

  const nextBit = () => {
    const byte = codewords[bitIndex >>> 3];
    // Past the end of the data: the remainder modules are left light.
    const bit = byte === undefined ? 0 : (byte >>> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit;
  };

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the timing column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (!matrix.isReserved(row, col)) matrix.set(row, col, nextBit());
      }
    }
    upward = !upward;
  }

  return bitIndex;
}

/** The eight mask conditions, by number. A module is flipped where true. */
export const MASKS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
];

/** XOR the mask over every data module, leaving function patterns alone. */
export function applyMask(matrix, maskNumber) {
  const condition = MASKS[maskNumber];
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (!matrix.isReserved(row, col) && condition(row, col)) {
        matrix.modules[row][col] ^= 1;
      }
    }
  }
}

/**
 * How badly a masked symbol scans, by the standard's four rules. Lower is
 * better, and the rules are weighted so that an accidental finder pattern
 * costs far more than an unbalanced colour ratio.
 */
export function penalty(matrix) {
  const { size } = matrix;
  const at = (row, col) => matrix.modules[row][col];
  let score = 0;

  // Rule 1: runs of five or more of the same colour, in both directions.
  for (let i = 0; i < size; i++) {
    for (const line of [
      (k) => at(i, k),
      (k) => at(k, i)
    ]) {
      let run = 1;
      for (let k = 1; k < size; k++) {
        if (line(k) === line(k - 1)) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2: every 2x2 block of one colour.
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const value = at(row, col);
      if (value === at(row, col + 1) && value === at(row + 1, col) && value === at(row + 1, col + 1)) {
        score += 3;
      }
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 sequence with four light modules beside
  // it. This is the expensive one, because a scanner that finds a fake finder
  // pattern looks for the symbol in the wrong place entirely.
  const finderLike = [1, 0, 1, 1, 1, 0, 1];
  const quiet = [0, 0, 0, 0];
  const matches = (read, start, pattern) =>
    pattern.every((want, offset) => read(start + offset) === want);

  for (let i = 0; i < size; i++) {
    for (const read of [
      (k) => (k < 0 || k >= size ? 0 : at(i, k)),
      (k) => (k < 0 || k >= size ? 0 : at(k, i))
    ]) {
      for (let start = 0; start <= size - 7; start++) {
        if (!matches(read, start, finderLike)) continue;
        const before = matches(read, start - 4, quiet);
        const after = matches(read, start + 7, quiet);
        if (before || after) score += 40;
      }
    }
  }

  // Rule 4: how far the dark proportion strays from half.
  let dark = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) dark += at(row, col);
  }
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * Format information: the error-correction level and mask number, protected by
 * a BCH(15,5) code and then XORed with a fixed mask.
 *
 * The XOR matters more than it looks. Without it, level M with mask 0 encodes
 * as fifteen zero bits — a blank strip beside the finder that a scanner cannot
 * distinguish from damage.
 */
export function formatBits(level, maskNumber) {
  const data = (EC_BITS[level] << 3) | maskNumber;

  let remainder = data << 10;
  for (let bit = 14; bit >= 10; bit--) {
    if (remainder & (1 << bit)) remainder ^= 0x537 << (bit - 10);
  }

  return ((data << 10) | remainder) ^ 0x5412;
}

/** Version information for symbols of version 7 and up: BCH(18,6). */
export function versionBits(version) {
  let remainder = version << 12;
  for (let bit = 17; bit >= 12; bit--) {
    if (remainder & (1 << bit)) remainder ^= 0x1f25 << (bit - 12);
  }
  return (version << 12) | remainder;
}

/** Write the format bits into both of the places a scanner looks for them. */
export function placeFormat(matrix, level, maskNumber) {
  const bits = formatBits(level, maskNumber);
  const { size } = matrix;
  const bit = (index) => (bits >> index) & 1;

  // Copy one: around the top-left finder, skipping the timing row and column.
  for (let i = 0; i <= 5; i++) matrix.set(8, i, bit(i), { reserve: true });
  matrix.set(8, 7, bit(6), { reserve: true });
  matrix.set(8, 8, bit(7), { reserve: true });
  matrix.set(7, 8, bit(8), { reserve: true });
  for (let i = 9; i <= 14; i++) matrix.set(14 - i, 8, bit(i), { reserve: true });

  // Copy two: split between the other two finders, so losing a corner does not
  // lose the information needed to read anything at all.
  for (let i = 0; i <= 7; i++) matrix.set(size - 1 - i, 8, bit(i), { reserve: true });
  for (let i = 8; i <= 14; i++) matrix.set(8, size - 15 + i, bit(i), { reserve: true });

  matrix.set(size - 8, 8, DARK, { reserve: true });
}

/** Write the version bits, for the versions that carry them. */
export function placeVersion(matrix) {
  if (matrix.version < 7) return;
  const bits = versionBits(matrix.version);
  const { size } = matrix;

  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const row = Math.floor(i / 3);
    const col = size - 11 + (i % 3);
    matrix.set(row, col, bit, { reserve: true });
    matrix.set(col, row, bit, { reserve: true });
  }
}
