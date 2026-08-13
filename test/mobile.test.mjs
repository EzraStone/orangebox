import test from 'node:test';
import assert from 'node:assert/strict';

import { createMobileAccess, mobileSessionCanAccess } from '../src/mobile.mjs';

test('mobile pairing issues revocable, expiring, read-only sessions', () => {
  let clock = 1_800_000_000_000;
  const mobile = createMobileAccess({ enabled: true, now: () => clock });
  assert.ok(mobile.pairingCode.length >= 20);

  const paired = mobile.pair({ code: mobile.pairingCode.toLowerCase(), name: 'Ezra phone', address: 'phone' });
  assert.equal(paired.status, 201);
  assert.match(paired.token, /^obm_/);
  assert.equal(paired.session.scope, 'read');
  assert.equal(mobile.authenticate(paired.token).name, 'Ezra phone');
  assert.equal(mobile.listSessions().length, 1);

  assert.equal(mobile.revoke(paired.session.id), true);
  assert.equal(mobile.authenticate(paired.token), null);

  const second = mobile.pair({ code: mobile.pairingCode, address: 'phone' });
  clock = second.session.expires_at + 1;
  assert.equal(mobile.authenticate(second.token), null);
  assert.equal(mobile.listSessions().length, 0);
});

test('mobile pairing rate-limits failures and rotates its secret', () => {
  const mobile = createMobileAccess({ enabled: true });
  const original = mobile.pairingCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(mobile.pair({ code: 'wrong', address: 'attacker' }).status, 401);
  }
  assert.equal(mobile.pair({ code: original, address: 'attacker' }).status, 429);
  const rotated = mobile.rotatePairingCode();
  assert.notEqual(rotated, original);
  assert.equal(mobile.pair({ code: original, address: 'new-device' }).status, 401);
  assert.equal(mobile.pair({ code: rotated, address: 'new-device' }).status, 201);
});

test('disabled mobile access exposes no pairing material', () => {
  const mobile = createMobileAccess();
  assert.equal(mobile.enabled, false);
  assert.equal(mobile.pairingCode, null);
  assert.equal(mobile.pair({ code: 'anything' }).status, 404);
});

test('mobile sessions can only read API data', () => {
  assert.equal(mobileSessionCanAccess('GET', '/api/runs'), true);
  assert.equal(mobileSessionCanAccess('HEAD', '/api/export/run'), true);
  assert.equal(mobileSessionCanAccess('POST', '/api/clear'), false);
  assert.equal(mobileSessionCanAccess('DELETE', '/api/runs/run'), false);
  assert.equal(mobileSessionCanAccess('POST', '/openai/v1/responses'), false);
  assert.equal(mobileSessionCanAccess('GET', '/r/run/openai/v1/models'), false);
});
