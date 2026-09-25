// §23.1 — GF(256) and Reed-Solomon.
//
// The generator polynomials below are the ones printed in the QR standard, so
// they check this implementation against the spec rather than against itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mul, div, exp, log, polyMul, generatorPoly, remainder, PRIMITIVE } from '../src/qr/galois.mjs';

test('the field uses the primitive polynomial QR specifies', () => {
  assert.equal(PRIMITIVE, 0x11d);
  // x^8 reduces to x^4 + x^3 + x^2 + 1 = 0x1d. If this is wrong every byte
  // downstream is wrong, and nothing else would tell you.
  assert.equal(exp(8), 0x1d);
  assert.equal(exp(0), 1);
  assert.equal(exp(255), 1, 'the field is cyclic with period 255');
});

test('multiplication is commutative, associative, and has 1 as identity', () => {
  for (const [a, b, c] of [[2, 3, 5], [17, 91, 200], [255, 128, 7]]) {
    assert.equal(mul(a, b), mul(b, a));
    assert.equal(mul(mul(a, b), c), mul(a, mul(b, c)));
    assert.equal(mul(a, 1), a);
    assert.equal(mul(a, 0), 0);
  }
});

test('division undoes multiplication', () => {
  for (let a = 1; a < 256; a += 17) {
    for (let b = 1; b < 256; b += 23) {
      assert.equal(div(mul(a, b), b), a, `${a} * ${b} / ${b}`);
    }
  }
  assert.throws(() => div(1, 0), /division by zero/);
  assert.throws(() => log(0), /log of zero/);
});

test('the generator polynomials match the ones in the standard', () => {
  // Published values. Getting these right is the difference between a QR code
  // that corrects errors and one that is merely a pattern of squares.
  assert.deepEqual([...generatorPoly(7)], [1, 127, 122, 154, 164, 11, 68, 117]);
  assert.deepEqual([...generatorPoly(10)], [1, 216, 194, 159, 111, 199, 94, 95, 113, 157, 193]);
  assert.deepEqual([...generatorPoly(13)], [1, 137, 73, 227, 17, 177, 17, 52, 13, 46, 43, 83, 132, 120]);
  assert.deepEqual(
    [...generatorPoly(15)],
    [1, 29, 196, 111, 163, 112, 74, 10, 105, 105, 139, 132, 151, 32, 134, 26]
  );
});

test('a generator polynomial is monic and of the right degree', () => {
  for (const degree of [7, 10, 13, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30]) {
    const poly = generatorPoly(degree);
    assert.equal(poly.length, degree + 1, `degree ${degree}`);
    assert.equal(poly[0], 1, 'monic');
  }
});

test('data followed by its remainder divides cleanly (§23.1)', () => {
  // The defining property of Reed-Solomon: the full codeword is a multiple of
  // the generator, so dividing it again leaves nothing. This checks the
  // remainder without needing a second implementation to compare against.
  for (const degree of [7, 10, 17, 26, 30]) {
    const data = Uint8Array.from({ length: 40 }, (_, i) => (i * 37 + 11) & 0xff);
    const ecc = remainder(data, degree);

    const codeword = Uint8Array.from([...data, ...ecc]);
    const leftover = remainder(codeword, degree);

    assert.ok(leftover.every((b) => b === 0), `degree ${degree} left ${[...leftover]}`);
  }
});

test('the remainder has exactly the requested number of codewords', () => {
  for (const degree of [7, 10, 22, 30]) {
    assert.equal(remainder(Uint8Array.of(1, 2, 3), degree).length, degree);
  }
});

test('polynomial multiplication grows degrees additively', () => {
  const product = polyMul(Uint8Array.of(1, 2), Uint8Array.of(1, 3));
  assert.equal(product.length, 3);
  // (x + 2)(x + 3) = x^2 + (2^3)x + 6 in GF(256): XOR for the middle term.
  assert.equal(product[0], 1);
  assert.equal(product[1], 2 ^ 3);
  assert.equal(product[2], mul(2, 3));
});

test('all-zero data still produces a valid remainder', () => {
  // Degenerate but reachable: a payload that happens to be all zeros must not
  // produce something the decoder reads as corrupt.
  const ecc = remainder(new Uint8Array(20), 10);
  assert.equal(ecc.length, 10);
  assert.ok(ecc.every((b) => b === 0), 'zero data has a zero remainder');
});
