// §22.2 — a self-signed certificate for local HTTPS.
//
// Mobile pairing has shipped over plain HTTP since it was added, which means
// every recorded prompt a paired phone loads crosses the LAN in the clear. It
// also means the browser withholds secure-context features — install prompts,
// notifications — so the mobile shell is worse than it needs to be for a second
// reason.
//
// This generates a P-256 key and a certificate for it. The certificate is not
// trusted by anything, and cannot be: nobody is going to get a real CA to issue
// for 192.168.1.х. What it buys is an encrypted channel and a secure context,
// after the user accepts it once. That is the honest trade and the docs say so.

import crypto from 'node:crypto';
import {
  sequence, set, integer, bitString, octetString, oid, time,
  boolean, utf8String, contextConstructed, contextPrimitive, tlv, TAG
} from './der.mjs';

const OID = {
  commonName: '2.5.4.3',
  organizationName: '2.5.4.10',
  ecPublicKey: '1.2.840.10045.2.1',
  prime256v1: '1.2.840.10045.3.1.7',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyIdentifier: '2.5.29.14',
  serverAuth: '1.3.6.1.5.5.7.3.1'
};

/** A Name with one commonName, plus an organization so it is recognisable. */
function name(commonName) {
  const attribute = (type, value) => set(sequence(oid(type), utf8String(value)));
  return sequence(attribute(OID.commonName, commonName), attribute(OID.organizationName, 'orangebox'));
}

/**
 * subjectAltName. Modern clients ignore commonName entirely and match only
 * against this, so a certificate without the address you actually browse to is
 * rejected however correct the rest of it is.
 *
 * DNS names are [2], IP addresses are [7] as raw 4- or 16-byte addresses.
 */
function subjectAltName({ hosts = [], ips = [] }) {
  const entries = [
    ...hosts.map((host) => contextPrimitive(2, Buffer.from(host, 'ascii'))),
    ...ips.map((ip) => contextPrimitive(7, ipToBytes(ip)))
  ];
  if (entries.length === 0) throw new Error('a certificate needs at least one host or IP');
  return sequence(entries);
}

/** Dotted IPv4 to four bytes. IPv6 is not attempted; a LAN pairing URL is v4. */
export function ipToBytes(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) throw new RangeError(`not an IPv4 address: ${ip}`);
  const bytes = parts.map((part) => {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255 || part !== String(n)) {
      throw new RangeError(`not an IPv4 address: ${ip}`);
    }
    return n;
  });
  return Buffer.from(bytes);
}

const extension = (id, critical, value) =>
  sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));

/**
 * Generate a key and a self-signed certificate for it.
 *
 * P-256 rather than RSA: the key generates in milliseconds instead of seconds,
 * which matters when this runs on first start of a command people expect to be
 * instant. Every browser and Node itself have supported it for a decade.
 *
 * Returns PEM for both, because that is what node:https wants.
 */
export function generateSelfSigned({
  hosts = ['localhost'],
  ips = ['127.0.0.1'],
  days = 397,
  commonName = hosts[0] ?? ips[0],
  now = new Date()
} = {}) {
  // Check before generating a key: without a name to match against, the
  // certificate would encode perfectly and be rejected by every client, and
  // the failure a few lines down is an unrelated-looking TypeError about the
  // subject field.
  if (hosts.length === 0 && ips.length === 0) throw new Error('a certificate needs at least one host or IP');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  // Node exports SubjectPublicKeyInfo already DER-encoded, which is the one
  // part of a certificate it would be genuinely painful to build by hand.
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  // A random serial, positive and under 20 bytes per RFC 5280. The high bit is
  // cleared rather than relying on the encoder's leading zero, so the serial is
  // 16 bytes rather than sometimes 17.
  const serialBytes = crypto.randomBytes(16);
  serialBytes[0] &= 0x7f;
  if (serialBytes[0] === 0) serialBytes[0] = 1;

  const algorithm = sequence(oid(OID.ecdsaWithSha256));
  const issuerAndSubject = name(commonName);

  // 397 days by default: the maximum a public CA may issue for, and a sensible
  // ceiling for something a browser has been told to trust by hand. Backdated
  // an hour so a client whose clock runs slow does not reject it on sight.
  const notBefore = new Date(now.getTime() - 3600_000);
  const notAfter = new Date(now.getTime() + days * 86_400_000);

  const tbs = sequence(
    contextConstructed(0, integer(2)), // v3
    integer(serialBytes),
    algorithm,
    issuerAndSubject,
    sequence(time(notBefore), time(notAfter)),
    issuerAndSubject, // self-signed: issuer is subject
    spki,
    contextConstructed(3, sequence(
      // Not a CA. Without this some clients will happily let it sign others.
      extension(OID.basicConstraints, true, sequence(boolean(false))),
      // digitalSignature | keyEncipherment
      extension(OID.keyUsage, true, tlv(TAG.BIT_STRING, Buffer.from([0x05, 0xa0]))),
      extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
      extension(OID.subjectAltName, false, subjectAltName({ hosts, ips })),
      extension(OID.subjectKeyIdentifier, false,
        octetString(crypto.createHash('sha1').update(spkiBitString(spki)).digest()))
    ))
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const certificate = sequence(tbs, algorithm, bitString(signature));

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: toPem(certificate, 'CERTIFICATE'),
    fingerprint: fingerprintOf(certificate),
    notBefore,
    notAfter,
    hosts,
    ips
  };
}

/**
 * The subjectKeyIdentifier is a hash of the public key bits, not of the whole
 * SPKI structure. Reaching into the DER for them is ugly; doing it wrong just
 * produces a different identifier, which nothing checks, but wrong is wrong.
 */
function spkiBitString(spki) {
  // SPKI is SEQUENCE { AlgorithmIdentifier, BIT STRING }. Walk to the last TLV.
  let offset = 2 + (spki[1] & 0x80 ? (spki[1] & 0x7f) : 0);
  while (offset < spki.length && spki[offset] !== TAG.BIT_STRING) {
    const lengthByte = spki[offset + 1];
    const lengthBytes = lengthByte & 0x80 ? lengthByte & 0x7f : 0;
    const length = lengthBytes === 0
      ? lengthByte
      : spki.subarray(offset + 2, offset + 2 + lengthBytes).reduce((a, b) => a * 256 + b, 0);
    offset += 2 + lengthBytes + length;
  }
  if (offset >= spki.length) return spki; // not the shape we expected; hash it all
  const lengthByte = spki[offset + 1];
  const lengthBytes = lengthByte & 0x80 ? lengthByte & 0x7f : 0;
  const length = lengthBytes === 0
    ? lengthByte
    : spki.subarray(offset + 2, offset + 2 + lengthBytes).reduce((a, b) => a * 256 + b, 0);
  // Skip the unused-bits byte.
  return spki.subarray(offset + 2 + lengthBytes + 1, offset + 2 + lengthBytes + length);
}

/** SHA-256 of the DER, colon-separated — what every tool shows for comparison. */
export function fingerprintOf(derCertificate) {
  return crypto
    .createHash('sha256')
    .update(derCertificate)
    .digest('hex')
    .toUpperCase()
    .match(/.{2}/g)
    .join(':');
}

/** DER to PEM: base64 in 64-character lines between the usual markers. */
export function toPem(der, label) {
  const body = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
