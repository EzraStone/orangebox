// §22.2 — the self-signed certificate.
//
// The test that matters is not that the bytes look right: it is that Node's own
// TLS stack completes a handshake with verification ON, using the certificate
// as its own CA. That exercises the whole structure — signature, validity
// dates, key usage, and subjectAltName matching — against an implementation
// that did not come from this repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { generateSelfSigned, ipToBytes, toPem, fingerprintOf } from '../src/tls/certificate.mjs';

/**
 * Serve one request over HTTPS and return what the client saw.
 *
 * agent: false and closeAllConnections() matter here: the default agent keeps
 * the socket alive, and server.close() then waits for it forever rather than
 * failing — the test simply hangs, which is a worse outcome than a failure.
 */
async function handshake({ cert, key }, { servername, host = '127.0.0.1', ca }) {
  const server = https.createServer({ cert, key }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    return await new Promise((resolve, reject) => {
      const request = https.request(
        {
          host, port, path: '/', ca, servername,
          rejectUnauthorized: Boolean(ca),
          agent: false
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          const peer = res.socket.getPeerCertificate();
          res.on('end', () => resolve({ status: res.statusCode, body, peer }));
        }
      );
      request.on('error', reject);
      request.setTimeout(5000, () => request.destroy(new Error('handshake timed out')));
      request.end();
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('node completes a verified handshake with the generated certificate', async () => {
  // rejectUnauthorized is on and the certificate is its own CA, so Node checks
  // the signature, the dates, and the name — everything a browser would.
  const generated = generateSelfSigned({ hosts: ['localhost'], ips: ['127.0.0.1'] });
  const result = await handshake(generated, { servername: 'localhost', ca: generated.cert });

  assert.equal(result.status, 200);
  assert.equal(result.body, 'ok');
});

test('an IP in subjectAltName is matched when connecting by IP', async () => {
  // Modern clients ignore commonName entirely. Without the IP in the SAN this
  // handshake fails however correct the rest of the certificate is — which is
  // exactly the case mobile pairing needs, since you browse to 192.168.x.y.
  const generated = generateSelfSigned({ hosts: [], ips: ['127.0.0.1'] });
  const result = await handshake(generated, { servername: '127.0.0.1', ca: generated.cert });
  assert.equal(result.status, 200);
});

test('a name that is not in the certificate is rejected', async () => {
  // Proves the previous tests passed because the name matched, not because
  // verification was quietly disabled.
  const generated = generateSelfSigned({ hosts: ['localhost'], ips: ['127.0.0.1'] });
  await assert.rejects(
    () => handshake(generated, { servername: 'not-in-the-cert.example', ca: generated.cert }),
    /altnames|Hostname|does not match/i
  );
});

test('a certificate signed by a different key is rejected', async () => {
  // And proves the signature is actually checked: serve one certificate while
  // claiming to trust another.
  const served = generateSelfSigned({ hosts: ['localhost'], ips: ['127.0.0.1'] });
  const other = generateSelfSigned({ hosts: ['localhost'], ips: ['127.0.0.1'] });

  await assert.rejects(
    () => handshake(served, { servername: 'localhost', ca: other.cert }),
    /self.signed|unable to verify|UNABLE_TO_VERIFY/i
  );
});

test('the certificate carries the fields a browser looks at', async () => {
  const generated = generateSelfSigned({
    hosts: ['localhost', 'orangebox.local'],
    ips: ['127.0.0.1', '192.168.1.42']
  });
  const result = await handshake(generated, { servername: 'localhost', ca: generated.cert });
  const peer = result.peer;

  assert.match(peer.subject.CN, /localhost/);
  assert.equal(peer.subject.CN, peer.issuer.CN, 'self-signed: issuer is subject');
  assert.match(peer.subjectaltname, /DNS:localhost/);
  assert.match(peer.subjectaltname, /DNS:orangebox\.local/);
  assert.match(peer.subjectaltname, /IP Address:127\.0\.0\.1/);
  assert.match(peer.subjectaltname, /IP Address:192\.168\.1\.42/);
  assert.ok(peer.serialNumber.length > 0);
});

test('an IPv4 address becomes four bytes, and anything else is refused', () => {
  // subjectAltName wants raw address bytes, not text. A malformed address that
  // silently encoded as something would produce a certificate that fails to
  // match with no clue why.
  assert.deepEqual([...ipToBytes('127.0.0.1')], [127, 0, 0, 1]);
  assert.deepEqual([...ipToBytes('192.168.1.42')], [192, 168, 1, 42]);
  assert.deepEqual([...ipToBytes('255.255.255.255')], [255, 255, 255, 255]);

  for (const bad of ['1.2.3', '1.2.3.4.5', '256.1.1.1', '1.1.1.-1', 'localhost', '01.2.3.4', '']) {
    assert.throws(() => ipToBytes(bad), /not an IPv4 address/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the fingerprint matches what the peer reports', async () => {
  // It is shown to the user so they can check the certificate their browser is
  // warning about is the one orangebox generated. If it does not match what a
  // client computes, it is worse than useless.
  const generated = generateSelfSigned({ hosts: ['localhost'], ips: ['127.0.0.1'] });
  const { peer } = await handshake(generated, { servername: 'localhost', ca: generated.cert });

  assert.equal(
    generated.fingerprint,
    peer.fingerprint256,
    'our fingerprint disagrees with the one the TLS stack computed'
  );
});

test('a certificate is backdated so a slow clock does not reject it', () => {
  // Machines on a LAN disagree about the time by seconds or minutes routinely.
  // notBefore in the future is an immediate rejection with a confusing message.
  const now = new Date('2026-09-25T12:00:00Z');
  const generated = generateSelfSigned({ hosts: ['localhost'], ips: ['127.0.0.1'], now });
  assert.ok(generated.notBefore < now, 'notBefore must be in the past');
  assert.ok(now - generated.notBefore >= 3600_000, 'by at least an hour');
});

test('validity defaults to 397 days, the public-CA maximum', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  const generated = generateSelfSigned({ hosts: ['localhost'], ips: ['127.0.0.1'], now });
  const days = (generated.notAfter - now) / 86_400_000;
  assert.ok(Math.abs(days - 397) < 1, `got ${days} days`);
});

test('a certificate with no host and no IP is refused', () => {
  // It would encode fine and be rejected by every client, since there would be
  // nothing for them to match against.
  assert.throws(
    () => generateSelfSigned({ hosts: [], ips: [] }),
    /at least one host or IP/
  );
});

test('PEM wraps at 64 characters with the right markers', () => {
  const pem = toPem(Buffer.alloc(200, 0xab), 'CERTIFICATE');
  const lines = pem.trim().split(String.fromCharCode(10));
  assert.equal(lines[0], '-----BEGIN CERTIFICATE-----');
  assert.equal(lines.at(-1), '-----END CERTIFICATE-----');
  for (const line of lines.slice(1, -1)) {
    assert.ok(line.length <= 64, `line of ${line.length} characters`);
  }
});

test('the fingerprint is the shape people compare by eye', () => {
  const fingerprint = fingerprintOf(Buffer.from('anything'));
  assert.match(fingerprint, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/, 'uppercase hex, colon separated');
});
