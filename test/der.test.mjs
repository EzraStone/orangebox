// §22.1 — the DER writer.
//
// Most of these check against byte sequences from the spec rather than against
// the encoder's own output, because "it round-trips through my own code" would
// prove nothing about whether a TLS stack will accept it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeLength, tlv, sequence, integer, bitString, octetString,
  oid, time, boolean, utf8String, TAG
} from '../src/tls/der.mjs';

const hex = (buf) => Buffer.from(buf).toString('hex');

test('short lengths use one byte, long ones announce their size', () => {
  // DER forbids the long form where the short form fits, so 127 and 128 sit on
  // either side of a hard boundary.
  assert.equal(hex(encodeLength(0)), '00');
  assert.equal(hex(encodeLength(127)), '7f');
  assert.equal(hex(encodeLength(128)), '8180');
  assert.equal(hex(encodeLength(255)), '81ff');
  assert.equal(hex(encodeLength(256)), '820100');
  assert.equal(hex(encodeLength(65535)), '82ffff');
  assert.equal(hex(encodeLength(65536)), '83010000');
});

test('an integer whose top bit is set gets a leading zero', () => {
  // The rule that bites in practice: DER integers are signed, so half of all
  // random serial numbers would encode as negative without this.
  assert.equal(hex(integer(0)), '020100');
  assert.equal(hex(integer(1)), '020101');
  assert.equal(hex(integer(127)), '02017f');
  assert.equal(hex(integer(128)), '02020080', '128 needs a leading zero');
  assert.equal(hex(integer(255)), '020200ff');
  assert.equal(hex(integer(256)), '02020100');
});

test('redundant leading zeros are stripped', () => {
  // DER has exactly one encoding per value; 0x00 0x01 is not it for 1.
  assert.equal(hex(integer(Buffer.from([0x00, 0x00, 0x01]))), '020101');
  assert.equal(hex(integer(Buffer.from([0x00, 0x80]))), '02020080', 'but not the meaningful one');
  assert.equal(hex(integer(Buffer.from([0x00]))), '020100');
});

test('OIDs pack their first two arcs into one byte', () => {
  // Known encodings: these appear in every certificate ever issued.
  assert.equal(hex(oid('2.5.4.3')), '0603550403', 'commonName');
  assert.equal(hex(oid('1.2.840.10045.4.3.2')), '06082a8648ce3d040302', 'ecdsa-with-SHA256');
  assert.equal(hex(oid('1.2.840.10045.2.1')), '06072a8648ce3d0201', 'id-ecPublicKey');
  assert.equal(hex(oid('2.5.29.17')), '0603551d11', 'subjectAltName');
  assert.equal(hex(oid('1.3.6.1.5.5.7.3.1')), '06082b06010505070301', 'serverAuth');
});

test('an OID arc above 127 spills into continuation bytes', () => {
  // 10045 is 0x274d, which needs two base-128 groups with the high bit set on
  // the first. Getting this wrong produces an OID that parses as something else
  // entirely rather than failing.
  assert.match(hex(oid('1.2.840.10045.2.1')), /8648ce3d/);
  assert.throws(() => oid('1'), /not an OID/);
  assert.throws(() => oid('1.2.x'), /not an OID/);
});

test('times before 2050 are UTCTime, after are GeneralizedTime', () => {
  // X.509 mandates the switch. A certificate dated 2050 with a UTCTime is
  // wrong in a way nothing notices until something rejects it.
  const utc = time(new Date('2026-09-25T12:34:56Z'));
  assert.equal(utc[0], TAG.UTC_TIME);
  assert.equal(utc.subarray(2).toString('ascii'), '260925123456Z');

  const generalized = time(new Date('2051-01-02T03:04:05Z'));
  assert.equal(generalized[0], TAG.GENERALIZED_TIME);
  assert.equal(generalized.subarray(2).toString('ascii'), '20510102030405Z');
});

test('a bit string records that no bits are unused', () => {
  assert.equal(hex(bitString(Buffer.from([0xab, 0xcd]))), '030300abcd');
});

test('a sequence wraps its parts and carries their total length', () => {
  const seq = sequence(integer(1), integer(2));
  assert.equal(seq[0], TAG.SEQUENCE);
  assert.equal(seq[1], 6, 'two three-byte integers');
  assert.equal(hex(seq), '3006020101020102');
});

test('a long sequence switches to the long length form', () => {
  const big = sequence(octetString(Buffer.alloc(300)));
  assert.equal(big[0], TAG.SEQUENCE);
  assert.equal(big[1] & 0x80, 0x80, 'long form');
});

test('booleans encode true as all ones, per DER', () => {
  // BER allows any non-zero byte; DER allows only 0xff, and a TLS stack that
  // checks will reject anything else.
  assert.equal(hex(boolean(true)), '0101ff');
  assert.equal(hex(boolean(false)), '010100');
});

test('utf8 strings carry their byte length, not their character count', () => {
  const value = utf8String('café');
  assert.equal(value[1], 5, 'é is two bytes');
});

test('tlv refuses a negative length', () => {
  assert.throws(() => encodeLength(-1), /cannot be negative/);
});
