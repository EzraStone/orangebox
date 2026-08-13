import crypto from 'node:crypto';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PAIR_WINDOW_MS = 60 * 1000;
const PAIR_ATTEMPTS_PER_WINDOW = 5;

/**
 * Ephemeral, read-only mobile access. Pairing codes and sessions intentionally
 * disappear when orangebox restarts; a local trace viewer should fail closed.
 */
export function createMobileAccess({ enabled = false, now = () => Date.now() } = {}) {
  let pairingCode = enabled ? makePairingCode() : null;
  const sessions = new Map();
  const failures = new Map();

  function pair({ code, name = 'Mobile device', address = '' } = {}) {
    if (!enabled) return { ok: false, status: 404, error: 'mobile access is disabled' };
    prune();

    const bucket = failures.get(address) ?? { startedAt: now(), count: 0 };
    if (now() - bucket.startedAt >= PAIR_WINDOW_MS) {
      bucket.startedAt = now();
      bucket.count = 0;
    }
    if (bucket.count >= PAIR_ATTEMPTS_PER_WINDOW) {
      return { ok: false, status: 429, error: 'too many pairing attempts; wait one minute' };
    }

    if (!safeEqual(normalizeCode(code), pairingCode)) {
      bucket.count += 1;
      failures.set(address, bucket);
      return { ok: false, status: 401, error: 'invalid pairing code' };
    }

    failures.delete(address);
    const token = `obm_${crypto.randomBytes(32).toString('base64url')}`;
    const session = {
      id: crypto.randomBytes(9).toString('base64url'),
      name: String(name || 'Mobile device').trim().slice(0, 80) || 'Mobile device',
      created_at: now(),
      last_seen_at: now(),
      expires_at: now() + SESSION_TTL_MS,
      scope: 'read'
    };
    sessions.set(hashToken(token), session);
    return { ok: true, status: 201, token, session: { ...session } };
  }

  function authenticate(token) {
    if (!enabled || typeof token !== 'string' || !token.startsWith('obm_')) return null;
    prune();
    const session = sessions.get(hashToken(token));
    if (!session) return null;
    session.last_seen_at = now();
    return { ...session };
  }

  function listSessions() {
    prune();
    return [...sessions.values()].map((session) => ({ ...session })).sort((a, b) => b.created_at - a.created_at);
  }

  function revoke(id) {
    for (const [key, session] of sessions) {
      if (session.id === id) return sessions.delete(key);
    }
    return false;
  }

  function rotatePairingCode() {
    if (!enabled) return null;
    pairingCode = makePairingCode();
    failures.clear();
    return pairingCode;
  }

  function prune() {
    const current = now();
    for (const [key, session] of sessions) if (session.expires_at <= current) sessions.delete(key);
    for (const [address, bucket] of failures) {
      if (current - bucket.startedAt >= PAIR_WINDOW_MS) failures.delete(address);
    }
  }

  return {
    enabled,
    get pairingCode() { return pairingCode; },
    pair,
    authenticate,
    listSessions,
    revoke,
    rotatePairingCode
  };
}

function makePairingCode() {
  // Hex avoids ambiguous URL-safe punctuation while preserving 120 bits of entropy.
  return crypto.randomBytes(15).toString('hex').toUpperCase();
}

function normalizeCode(value) {
  return String(value ?? '').trim().replace(/[\s-]/g, '').toUpperCase();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

export const MOBILE_SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

export function mobileSessionCanAccess(method, pathname) {
  return ['GET', 'HEAD'].includes(method) && String(pathname).startsWith('/api/');
}
