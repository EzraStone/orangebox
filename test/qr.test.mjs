// §23 — the QR encoder, end to end.
//
// The important test here decodes the symbol back. The decoder below is
// written from the reading side — it recovers the mask from the format bits
// rather than being told which was used, walks the placement order itself, and
// de-interleaves by the block table. If it can read the payload out, then the
// format information, the masking and the placement all agree with each other
// and with the structure a scanner expects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, toText, toSvg } from '../src/qr/index.mjs';
import { formatBits, MASKS, Matrix, placeFunctionPatterns } from '../src/qr/matrix.mjs';
import { blocksFor, dataCodewords, EC_LEVELS } from '../src/qr/tables.mjs';

/** Which modules are structural, worked out independently of the encoder. */
function reservedMap(version) {
  const matrix = new Matrix(version);
  placeFunctionPatterns(matrix);
  return matrix.reserved;
}

/** Recover the error-correction level and mask from the format area. */
function readFormat(modules) {
  const size = modules.length;
  let bits = 0;
  // The first copy: row 8 leftwards, then column 8 upwards.
  for (let i = 0; i <= 5; i++) bits |= modules[8][i] << i;
  bits |= modules[8][7] << 6;
  bits |= modules[8][8] << 7;
  bits |= modules[7][8] << 8;
  for (let i = 9; i <= 14; i++) bits |= modules[14 - i][8] << i;

  // Real decoders pick the closest valid format value by Hamming distance,
  // which is the whole point of the BCH code. Doing the same here means the
  // test is not merely reversing whatever the encoder wrote.
  let best = null;
  for (const level of EC_LEVELS) {
    for (let mask = 0; mask < 8; mask++) {
      const candidate = formatBits(level, mask);
      const distance = popcount(candidate ^ bits);
      if (best === null || distance < best.distance) best = { level, mask, distance };
    }
  }
  return best;
}

const popcount = (n) => {
  let count = 0;
  for (let i = 0; i < 16; i++) if (n & (1 << i)) count++;
  return count;
};

/** Read the payload back out of a finished symbol. */
function decode(qr) {
  const modules = qr.modules.map((row) => [...row]);
  const size = modules.length;
  const { level, mask } = readFormat(modules);

  const reserved = reservedMap(qr.version);
  const condition = MASKS[mask];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!reserved[row][col] && condition(row, col)) modules[row][col] ^= 1;
    }
  }

  // Walk the placement order and collect bits.
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (!reserved[row][col]) bits.push(modules[row][col]);
      }
    }
    upward = !upward;
  }

  const codewords = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }

  // De-interleave using the block structure.
  const [ecPerBlock, group1, data1, group2, data2] = blocksFor(qr.version, level);
  const sizes = [...Array(group1).fill(data1), ...Array(group2).fill(data2)];
  const blocks = sizes.map(() => []);
  let index = 0;
  for (let i = 0; i < Math.max(...sizes); i++) {
    for (let b = 0; b < sizes.length; b++) {
      if (i < sizes[b]) blocks[b].push(codewords[index++]);
    }
  }
  void ecPerBlock;

  const data = blocks.flat();
  // Header: 4 bits of mode, then the character count.
  const countBits = qr.version < 10 ? 8 : 16;
  const stream = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((b) => (byte >> b) & 1));

  const take = (offset, length) => stream.slice(offset, offset + length).reduce((a, b) => (a << 1) | b, 0);
  const mode = take(0, 4);
  const length = take(4, countBits);

  const bytes = [];
  for (let i = 0; i < length; i++) bytes.push(take(4 + countBits + i * 8, 8));

  return { mode, level, mask, text: Buffer.from(bytes).toString('utf8') };
}

test('a symbol decodes back to what went in (§23)', () => {
  // The test this whole module rests on.
  const payload = 'https://192.168.1.42:4100/#pair=ABCD1234EFGH5678';
  const qr = encode(payload, { level: 'M' });
  const decoded = decode(qr);

  assert.equal(decoded.mode, 0b0100, 'byte mode');
  assert.equal(decoded.level, 'M', 'the level was recovered from the format bits');
  assert.equal(decoded.mask, qr.mask, 'and so was the mask');
  assert.equal(decoded.text, payload);
});

test('every error-correction level round-trips', () => {
  const payload = 'orangebox pairing';
  for (const level of EC_LEVELS) {
    const qr = encode(payload, { level });
    assert.equal(decode(qr).text, payload, `level ${level}`);
  }
});

test('every mask round-trips, so none of the eight is wrong', () => {
  // The encoder picks one by score; a mask that is subtly wrong would only
  // show up on the payloads that happen to select it.
  const payload = 'mask check payload';
  for (let mask = 0; mask < 8; mask++) {
    const qr = encode(payload, { level: 'Q', mask });
    const decoded = decode(qr);
    assert.equal(decoded.mask, mask, `mask ${mask} was not recorded correctly`);
    assert.equal(decoded.text, payload, `mask ${mask} did not round-trip`);
  }
});

test('payloads of every length round-trip at their chosen version', () => {
  // Walks across version boundaries, where the character-count field and the
  // block structure both change.
  for (const length of [1, 14, 15, 40, 60, 100, 150, 200]) {
    const payload = 'x'.repeat(length);
    const qr = encode(payload, { level: 'L' });
    assert.equal(decode(qr).text, payload, `${length} bytes at version ${qr.version}`);
  }
});

test('utf-8 survives the round trip', () => {
  const payload = 'café — ☕ 日本';
  assert.equal(decode(encode(payload, { level: 'M' })).text, payload);
});

test('the three finder patterns are where a scanner looks for them', () => {
  // A scanner locates the symbol by these before reading anything. If they are
  // wrong the code is not merely unreadable, it is invisible.
  const qr = encode('finder check', { level: 'M' });
  const m = qr.modules;
  const size = qr.size;

  const finderAt = (top, left) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(
          m[top + r][left + c], ring || core ? 1 : 0,
          `finder at ${top},${left} wrong at ${r},${c}`
        );
      }
    }
  };

  finderAt(0, 0);
  finderAt(0, size - 7);
  finderAt(size - 7, 0);

  // And the fourth corner must NOT have one — that is how orientation is read.
  const bottomRight = m[size - 7][size - 7] && m[size - 1][size - 1];
  assert.ok(!bottomRight, 'a fourth finder would destroy orientation');
});

test('the timing patterns alternate, which is how modules are counted', () => {
  const qr = encode('timing check', { level: 'M' });
  for (let i = 8; i < qr.size - 8; i++) {
    assert.equal(qr.modules[6][i], i % 2 === 0 ? 1 : 0, `horizontal timing at ${i}`);
    assert.equal(qr.modules[i][6], i % 2 === 0 ? 1 : 0, `vertical timing at ${i}`);
  }
});

test('the dark module is set, as the standard requires', () => {
  for (const level of EC_LEVELS) {
    const qr = encode('dark module', { level });
    assert.equal(qr.modules[qr.size - 8][8], 1, `level ${level}`);
  }
});

test('the chosen mask is the lowest-scoring one', () => {
  // Masking is not cosmetic: the penalty rules exist to avoid patterns that
  // defeat scanners, so picking anything other than the best is a real defect.
  const payload = 'https://192.168.1.42:4100/#pair=WXYZ';
  const auto = encode(payload, { level: 'M' });

  for (let mask = 0; mask < 8; mask++) {
    const forced = encode(payload, { level: 'M', mask });
    assert.ok(
      forced.penalty >= auto.penalty,
      `mask ${mask} scores ${forced.penalty}, better than the chosen ${auto.mask} at ${auto.penalty}`
    );
  }
});

test('text rendering includes the quiet zone scanners need', () => {
  // Without four clear modules around it, many scanners will not see the
  // symbol at all — which reads as a broken encoder rather than a margin.
  const qr = encode('quiet zone', { level: 'M' });
  const lines = toText(qr, { dark: '#', light: '.', quiet: 4 }).split('\n');

  assert.equal(lines.length, qr.size + 8);
  assert.ok(lines.slice(0, 4).every((line) => /^\.+$/.test(line)), 'top margin is clear');
  assert.ok(lines.slice(-4).every((line) => /^\.+$/.test(line)), 'bottom margin is clear');
  for (const line of lines) {
    assert.match(line.slice(0, 4), /^\.{4}$/, 'left margin is clear');
    assert.match(line.slice(-4), /^\.{4}$/, 'right margin is clear');
  }
});

test('svg output is one path and scales with the module count', () => {
  const qr = encode('svg check', { level: 'M' });
  const svg = toSvg(qr, { scale: 4, quiet: 4 });

  const expected = (qr.size + 8) * 4;
  assert.match(svg, new RegExp(`width="${expected}"`));
  assert.match(svg, new RegExp(`viewBox="0 0 ${expected} ${expected}"`));
  assert.equal((svg.match(/<path/g) ?? []).length, 1, 'one path, not a rect per module');
  assert.ok(svg.includes('</svg>'));
});

test('a real pairing URL fits in a small symbol', () => {
  // The URL the CLI prints, at its longest: a LAN address, a port, and a
  // 30-character pairing code. If this needed a large version the terminal
  // rendering would stop being practical.
  const url = 'http://192.168.100.100:4100/#pair=7EC0047DD53BA9A6D54703159A4E23';
  const qr = encode(url, { level: 'L' });

  assert.ok(qr.version <= 5, `pairing URL needed version ${qr.version}`);
  assert.ok(qr.size <= 37, `symbol is ${qr.size} modules across`);
  assert.equal(decode(qr).text, url);
});

test('an https pairing URL also fits', () => {
  const url = 'https://192.168.100.100:4100/#pair=7EC0047DD53BA9A6D54703159A4E23';
  const qr = encode(url, { level: 'L' });
  assert.ok(qr.version <= 5);
  assert.equal(decode(qr).text, url);
});

test('GET /api/mobile/pair.svg serves a scannable pairing symbol (§23)', async () => {
  const { startOrangebox, removeTempDir } = await import('./helpers.mjs');
  const app = await startOrangebox({ mobileAccess: true });

  try {
    const res = await fetch(`${app.origin}/api/mobile/pair.svg`);

    // A machine with no LAN address cannot pair at all, and says so rather
    // than serving a QR pointing at somewhere unreachable.
    if (res.status === 409) {
      assert.match((await res.json()).error, /no LAN address/);
      return;
    }

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
    assert.equal(res.headers.get('cache-control'), 'no-store', 'a rotated code must not serve a stale QR');

    const svg = await res.text();
    assert.match(svg, /^<svg /);
    assert.match(svg, /<path /);
    assert.ok(svg.length > 500, 'the symbol has content');
  } finally {
    await app.close();
    removeTempDir(app.dbPath);
  }
});

test('the pairing QR is refused when mobile access is off', async () => {
  const { startOrangebox, removeTempDir } = await import('./helpers.mjs');
  const app = await startOrangebox({});

  try {
    const res = await fetch(`${app.origin}/api/mobile/pair.svg`);
    assert.equal(res.status, 404);
  } finally {
    await app.close();
    removeTempDir(app.dbPath);
  }
});

test('the pairing url points at the LAN address, not loopback', async () => {
  // The whole reason this is generated server-side. A QR containing 127.0.0.1
  // works on exactly one device: the one that does not need to scan it.
  const { pairingUrl, lanAddress } = await import('../src/mobile.mjs');

  const address = lanAddress();
  const url = pairingUrl({ code: 'ABC123', port: 4100, scheme: 'http' });

  if (address === null) {
    assert.equal(url, null, 'no LAN address means no pairing URL');
    return;
  }

  assert.equal(url, `http://${address}:4100/#pair=ABC123`);
  assert.doesNotMatch(url, /127\.0\.0\.1|localhost/);
  assert.equal(pairingUrl({ code: null, port: 4100 }), null, 'no code, no URL');
  assert.match(pairingUrl({ code: 'X', port: 443, scheme: 'https' }), /^https:/);
});
