// §23.1 — GF(256) arithmetic for QR's Reed-Solomon error correction.
//
// Every byte is an element of a field with 256 members. Addition is XOR, which
// makes it its own inverse and means subtraction is the same operation.
// Multiplication is polynomial multiplication modulo 0x11D, the primitive
// polynomial QR specifies — and the usual trick applies: precompute a log and
// an antilog table once, then multiply by adding logs.

/** x^8 + x^4 + x^3 + x^2 + 1 — fixed by the QR standard, not a choice. */
export const PRIMITIVE = 0x11d;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= PRIMITIVE;
  }
  // The table is doubled so a sum of two logs (max 254 + 254) can be looked up
  // without a modulo in the inner loop.
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

/** Multiply two field elements. Zero is absorbing, and has no logarithm. */
export function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Divide. Dividing by zero is a bug in the caller, not a value to return. */
export function div(a, b) {
  if (b === 0) throw new RangeError('division by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[LOG[a] + 255 - LOG[b]];
}

/** 2^exponent in the field — the form generator polynomials are written in. */
export function exp(exponent) {
  return EXP[((exponent % 255) + 255) % 255];
}

export function log(value) {
  if (value === 0) throw new RangeError('log of zero in GF(256)');
  return LOG[value];
}

/**
 * Multiply two polynomials, coefficients highest-order first.
 *
 * Schoolbook, because the polynomials here are at most 30 terms and a
 * transform would be more code for no measurable gain.
 */
export function polyMul(a, b) {
  const result = new Uint8Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j] ^= mul(a[i], b[j]);
    }
  }
  return result;
}

/**
 * The generator polynomial for `degree` error-correction codewords:
 * (x - 2^0)(x - 2^1)...(x - 2^(degree-1)), expanded.
 *
 * Subtraction is XOR here, so the minus signs vanish.
 */
export function generatorPoly(degree) {
  let poly = Uint8Array.of(1);
  for (let i = 0; i < degree; i++) {
    poly = polyMul(poly, Uint8Array.of(1, exp(i)));
  }
  return poly;
}

/**
 * The Reed-Solomon remainder: divide the data, shifted up by `degree`, by the
 * generator, and keep what is left. Those bytes are the error correction.
 */
export function remainder(data, degree) {
  const generator = generatorPoly(degree);
  const result = new Uint8Array(degree);

  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[degree - 1] = 0;
    for (let i = 0; i < degree; i++) {
      result[i] ^= mul(generator[i + 1], factor);
    }
  }
  return result;
}
