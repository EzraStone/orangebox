// §22.1 — just enough ASN.1 DER to write an X.509 certificate.
//
// orangebox has a one-dependency budget and it is spent on SQLite, so the
// certificate for local HTTPS is assembled here rather than pulled from npm.
// This is a writer only: nothing in orangebox parses DER, and a parser is where
// the security bugs in ASN.1 libraries almost always live.
//
// DER is TLV — tag, length, value — with the rule that there is exactly one
// valid encoding of any value. That last part is what makes it safe to write by
// hand: there are no choices to get subtly wrong, only rules to follow.

/** Universal tag numbers, plus the two context-specific ones a cert needs. */
export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18
};

/**
 * Encode a length in DER's definite form.
 *
 * Short form for 0–127, long form otherwise: a leading byte with the high bit
 * set and the count of following length bytes, then the length big-endian with
 * no leading zeros. DER forbids using long form where short would do, which is
 * why this is not simply "always write four bytes".
 */
export function encodeLength(length) {
  if (length < 0) throw new RangeError(`length cannot be negative: ${length}`);
  if (length < 0x80) return Buffer.from([length]);

  const bytes = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  if (bytes.length > 126) throw new RangeError('length too large for DER long form');
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One TLV. */
export function tlv(tag, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

export const sequence = (...parts) => tlv(TAG.SEQUENCE, Buffer.concat(parts.flat()));
export const set = (...parts) => tlv(TAG.SET, Buffer.concat(parts.flat()));

/**
 * INTEGER. Two's complement and big-endian, with the minimum number of bytes.
 *
 * The leading-zero rule is the one that bites: DER integers are signed, so a
 * value whose top byte has the high bit set needs a 0x00 in front or it reads
 * as negative. A serial number is the usual victim — half of all random ones
 * start with a byte above 0x7f.
 */
export function integer(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`integer() takes a non-negative safe integer, got ${value}`);
    }
    if (value === 0) return tlv(TAG.INTEGER, Buffer.from([0]));
    const bytes = [];
    let remaining = value;
    while (remaining > 0) {
      bytes.unshift(remaining & 0xff);
      remaining = Math.floor(remaining / 256);
    }
    return integer(Buffer.from(bytes));
  }

  let bytes = Buffer.from(value);
  // Strip redundant leading zeros, then re-add one if the result looks negative.
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0x00 && (bytes[start + 1] & 0x80) === 0) start++;
  bytes = bytes.subarray(start);
  if (bytes.length === 0) bytes = Buffer.from([0]);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  return tlv(TAG.INTEGER, bytes);
}

/**
 * BIT STRING. The first content byte counts unused bits in the final byte,
 * which is always 0 here — everything orangebox encodes is whole bytes.
 */
export const bitString = (bytes) => tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([0x00]), Buffer.from(bytes)]));

export const octetString = (bytes) => tlv(TAG.OCTET_STRING, Buffer.from(bytes));
export const utf8String = (text) => tlv(TAG.UTF8_STRING, Buffer.from(text, 'utf8'));
export const printableString = (text) => tlv(TAG.PRINTABLE_STRING, Buffer.from(text, 'ascii'));
export const boolean = (value) => tlv(TAG.BOOLEAN, Buffer.from([value ? 0xff : 0x00]));
export const nullValue = () => tlv(TAG.NULL, Buffer.alloc(0));

/** Context-specific constructed tag, e.g. [0] for a cert's version field. */
export const contextConstructed = (number, value) => tlv(0xa0 | number, value);

/** Context-specific primitive tag, used inside subjectAltName. */
export const contextPrimitive = (number, value) => tlv(0x80 | number, Buffer.from(value));

/**
 * OBJECT IDENTIFIER, from dotted decimal.
 *
 * The first two arcs are packed into one byte as 40*a + b, and every arc after
 * that is base-128 with the high bit set on all but the final byte. It looks
 * arbitrary because it is: it dates from when saving three bytes per OID
 * mattered.
 */
export function oid(dotted) {
  const arcs = String(dotted).split('.').map(Number);
  if (arcs.length < 2 || arcs.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new RangeError(`not an OID: ${dotted}`);
  }

  const bytes = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunks = [arc & 0x7f];
    let remaining = Math.floor(arc / 128);
    while (remaining > 0) {
      chunks.unshift((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(...chunks);
  }
  return tlv(TAG.OID, Buffer.from(bytes));
}

/**
 * UTCTime, as YYMMDDHHMMSSZ.
 *
 * X.509 says to use UTCTime for years through 2049 and GeneralizedTime after,
 * so this picks for you rather than letting a certificate dated 2050 be wrong
 * in a way nothing notices until it is rejected.
 */
export function time(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) throw new RangeError(`not a date: ${date}`);

  const p = (n, width = 2) => String(n).padStart(width, '0');
  const year = d.getUTCFullYear();
  const rest =
    p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';

  return year < 2050
    ? tlv(TAG.UTC_TIME, Buffer.from(p(year % 100) + rest, 'ascii'))
    : tlv(TAG.GENERALIZED_TIME, Buffer.from(p(year, 4) + rest, 'ascii'));
}
