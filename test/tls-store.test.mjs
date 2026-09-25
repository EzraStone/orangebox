// §22.3 — reusing the generated certificate between runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCertificate, reasonToRegenerate } from '../src/tls/index.mjs';

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-tls-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a certificate is generated once and reused', () => {
  // Regenerating every start means the browser warning you accepted yesterday
  // returns today and the fingerprint is different each time — which teaches
  // people to click through certificate warnings without reading them.
  const { dir, cleanup } = tempDir();
  try {
    const first = ensureCertificate({ dir, hosts: ['localhost'], ips: ['127.0.0.1'] });
    assert.equal(first.generated, true);
    assert.equal(first.reason, 'no certificate yet');

    const second = ensureCertificate({ dir, hosts: ['localhost'], ips: ['127.0.0.1'] });
    assert.equal(second.generated, false, 'the second call must reuse');
    assert.equal(second.fingerprint, first.fingerprint, 'and the fingerprint must not move');
    assert.equal(second.cert, first.cert);
  } finally {
    cleanup();
  }
});

test('a new LAN address forces a new certificate', () => {
  // The common case: the laptop moved network. The old certificate is entirely
  // valid and entirely useless for the address the phone will browse to.
  const { dir, cleanup } = tempDir();
  try {
    const first = ensureCertificate({ dir, hosts: [], ips: ['192.168.1.42'] });
    const moved = ensureCertificate({ dir, hosts: [], ips: ['10.0.0.7'] });

    assert.equal(moved.generated, true);
    assert.match(moved.reason, /does not cover 10\.0\.0\.7/);
    assert.notEqual(moved.fingerprint, first.fingerprint);
  } finally {
    cleanup();
  }
});

test('an expiring certificate is replaced before it expires', () => {
  // Expiring mid-session would take the mobile connection down with no warning
  // and no obvious cause.
  const now = Date.UTC(2026, 0, 1);
  const manifest = { hosts: ['localhost'], ips: [], notAfter: new Date(now + 5 * 86_400_000).toISOString() };

  assert.match(reasonToRegenerate(manifest, { hosts: ['localhost'], ips: [], now }), /expires soon/);

  const healthy = { ...manifest, notAfter: new Date(now + 200 * 86_400_000).toISOString() };
  assert.equal(reasonToRegenerate(healthy, { hosts: ['localhost'], ips: [], now }), null);

  const expired = { ...manifest, notAfter: new Date(now - 86_400_000).toISOString() };
  assert.match(reasonToRegenerate(expired, { hosts: ['localhost'], ips: [], now }), /has expired/);
});

test('a manifest without a usable expiry is not trusted', () => {
  const now = Date.now();
  assert.match(reasonToRegenerate({ notAfter: 'whenever' }, { hosts: [], ips: [], now }), /no usable expiry/);
  assert.match(reasonToRegenerate({}, { hosts: [], ips: [], now }), /no usable expiry/);
  assert.match(reasonToRegenerate(null, { hosts: [], ips: [], now }), /no certificate yet/);
});

test('a missing key file regenerates rather than failing to start', () => {
  // The manifest says everything is fine but the file is gone. Refusing to
  // start over a file orangebox owns and can recreate would be the wrong call.
  const { dir, cleanup } = tempDir();
  try {
    ensureCertificate({ dir, hosts: ['localhost'], ips: ['127.0.0.1'] });
    fs.rmSync(path.join(dir, 'key.pem'));

    const recovered = ensureCertificate({ dir, hosts: ['localhost'], ips: ['127.0.0.1'] });
    assert.equal(recovered.generated, true);
    assert.ok(fs.existsSync(path.join(dir, 'key.pem')));
  } finally {
    cleanup();
  }
});

test('the private key is not world-readable', { skip: process.platform === 'win32' }, () => {
  // Writing a key world-readable is the kind of thing that survives for years
  // because nothing ever complains about it.
  const { dir, cleanup } = tempDir();
  try {
    ensureCertificate({ dir, hosts: ['localhost'], ips: ['127.0.0.1'] });
    const mode = fs.statSync(path.join(dir, 'key.pem')).mode & 0o777;
    assert.equal(mode & 0o077, 0, `key.pem is mode ${mode.toString(8)}`);
  } finally {
    cleanup();
  }
});

test('a stored certificate still completes a handshake', async () => {
  // Reading PEM back off disk and serving it is the path every run after the
  // first takes, so it is worth proving rather than assuming.
  const https = await import('node:https');
  const { dir, cleanup } = tempDir();

  try {
    ensureCertificate({ dir, hosts: ['localhost'], ips: ['127.0.0.1'] });
    const reused = ensureCertificate({ dir, hosts: ['localhost'], ips: ['127.0.0.1'] });
    assert.equal(reused.generated, false);

    const server = https.createServer({ cert: reused.cert, key: reused.key }, (req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const body = await new Promise((resolve, reject) => {
        const request = https.request(
          { host: '127.0.0.1', port, path: '/', ca: reused.cert, servername: 'localhost', agent: false },
          (res) => {
            let text = '';
            res.on('data', (c) => (text += c));
            res.on('end', () => resolve(text));
          }
        );
        request.on('error', reject);
        request.end();
      });
      assert.equal(body, 'ok');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    cleanup();
  }
});
