// §22.3 — keep the generated certificate between runs.
//
// Regenerating on every start would work, but it would also mean the browser
// warning you clicked through yesterday comes back today, and the fingerprint
// you checked is different every time. Both of those train people to accept
// certificate warnings without looking, which is the opposite of the point.
//
// So the certificate is written once and reused until it stops being valid for
// what is actually being served.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateSelfSigned } from './certificate.mjs';

export function defaultTlsDir() {
  return path.join(os.homedir(), '.orangebox', 'tls');
}

/** Regenerate this long before expiry, so it never expires mid-session. */
const RENEW_WITHIN_MS = 14 * 86_400_000;

/**
 * Why a stored certificate cannot be reused, or null if it can.
 *
 * The addresses are compared against a manifest written alongside the
 * certificate rather than by parsing it back. orangebox writes DER and does not
 * read it (§22.1) — adding a parser to answer a question we already know the
 * answer to would be the wrong trade.
 */
export function reasonToRegenerate(manifest, { hosts, ips, now = Date.now() }) {
  if (!manifest) return 'no certificate yet';

  const notAfter = Date.parse(manifest.notAfter);
  if (!Number.isFinite(notAfter)) return 'stored certificate has no usable expiry';
  if (notAfter - now < RENEW_WITHIN_MS) {
    return notAfter < now ? 'certificate has expired' : 'certificate expires soon';
  }

  const covered = new Set([...(manifest.hosts ?? []), ...(manifest.ips ?? [])]);
  const missing = [...hosts, ...ips].filter((name) => !covered.has(name));
  // The common case: the laptop moved network and has a new LAN address, so
  // the old certificate is perfectly valid and useless.
  if (missing.length > 0) return `certificate does not cover ${missing.join(', ')}`;

  return null;
}

/**
 * Load the stored certificate, or make one.
 *
 * Returns { key, cert, fingerprint, path, generated, reason } — `generated`
 * says whether this run made a new one, which the banner uses to decide whether
 * to tell the user their browser is about to complain again.
 */
export function ensureCertificate({
  dir = defaultTlsDir(),
  hosts = ['localhost'],
  ips = ['127.0.0.1'],
  now = Date.now()
} = {}) {
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  const metaPath = path.join(dir, 'meta.json');

  const manifest = readManifest(metaPath);
  const reason = reasonToRegenerate(manifest, { hosts, ips, now });

  if (!reason) {
    try {
      return {
        key: fs.readFileSync(keyPath, 'utf8'),
        cert: fs.readFileSync(certPath, 'utf8'),
        fingerprint: manifest.fingerprint,
        notAfter: new Date(manifest.notAfter),
        path: certPath,
        generated: false,
        reason: null
      };
    } catch {
      // The manifest says it is fine but a file is gone. Fall through and make
      // a new one rather than failing to start over a missing file we own.
    }
  }

  const generated = generateSelfSigned({ hosts, ips, now: new Date(now) });
  fs.mkdirSync(dir, { recursive: true });

  // The key goes down before the certificate and with restrictive permissions.
  // Writing it world-readable even briefly is the kind of thing that survives
  // for years because nothing ever complains about it.
  fs.writeFileSync(keyPath, generated.key, { mode: 0o600 });
  fs.writeFileSync(certPath, generated.cert, { mode: 0o644 });
  fs.writeFileSync(
    metaPath,
    JSON.stringify({
      hosts, ips,
      fingerprint: generated.fingerprint,
      notBefore: generated.notBefore.toISOString(),
      notAfter: generated.notAfter.toISOString(),
      generated_at: new Date(now).toISOString()
    }, null, 2),
    { mode: 0o644 }
  );

  return {
    key: generated.key,
    cert: generated.cert,
    fingerprint: generated.fingerprint,
    notAfter: generated.notAfter,
    path: certPath,
    generated: true,
    reason: reason ?? 'no certificate yet'
  };
}

function readManifest(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
