// §07 — AWS event-stream framing. Bedrock is the only provider that does not
// stream text, so every one of these cases is about not desynchronising on a
// binary buffer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFrames, decodeFrame, encodeFrame, frameJson } from '../src/parse/eventstream.mjs';

const event = (type, body) =>
  encodeFrame(
    { ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' },
    Buffer.from(JSON.stringify(body), 'utf8')
  );

test('a single frame round-trips through headers and payload', () => {
  const frame = decodeFrame(event('contentBlockDelta', { delta: { text: 'hi' } }));
  assert.equal(frame.headers[':event-type'], 'contentBlockDelta');
  assert.equal(frame.headers[':content-type'], 'application/json');
  assert.deepEqual(frameJson(frame), { delta: { text: 'hi' } });
});

test('several frames in one buffer come back in order', () => {
  const buffer = Buffer.concat([
    event('messageStart', { role: 'assistant' }),
    event('contentBlockDelta', { delta: { text: 'one' } }),
    event('contentBlockDelta', { delta: { text: 'two' } }),
    event('messageStop', { stopReason: 'end_turn' })
  ]);

  const { frames, rest } = splitFrames(buffer);
  assert.equal(frames.length, 4);
  assert.equal(rest.length, 0);
  assert.deepEqual(
    frames.map((f) => f.headers[':event-type']),
    ['messageStart', 'contentBlockDelta', 'contentBlockDelta', 'messageStop']
  );
});

test('a frame split across chunks is held back, not half-decoded', () => {
  // This is the case that matters: TCP hands over whatever it has, and a
  // decoder that guesses at a partial frame corrupts everything after it.
  const whole = Buffer.concat([
    event('messageStart', { role: 'assistant' }),
    event('contentBlockDelta', { delta: { text: 'hello' } })
  ]);

  for (let cut = 1; cut < whole.length; cut++) {
    const first = splitFrames(whole.subarray(0, cut));
    const second = splitFrames(Buffer.concat([first.rest, whole.subarray(cut)]));
    const all = [...first.frames, ...second.frames];

    assert.equal(all.length, 2, `lost a frame when cut at byte ${cut}`);
    assert.equal(second.rest.length, 0, `left bytes over when cut at byte ${cut}`);
    assert.equal(frameJson(all[1]).delta.text, 'hello', `payload corrupted at cut ${cut}`);
  }
});

test('a nonsense length stops the scan instead of running away', () => {
  // A length field of 0 would make the cursor never advance. A gigantic one
  // would make it wait forever for bytes that are not coming.
  for (const bogus of [0, 1, 15, 0xffffffff]) {
    const buffer = Buffer.alloc(64);
    buffer.writeUInt32BE(bogus, 0);
    const { frames, rest } = splitFrames(buffer);
    assert.equal(frames.length, 0, `decoded a frame from length ${bogus}`);
    assert.equal(rest.length, 64, 'the whole buffer is handed back untouched');
  }
});

test('a good frame after a truncated one is still recovered', () => {
  const good = event('messageStop', { stopReason: 'max_tokens' });
  const { frames, rest } = splitFrames(Buffer.concat([good, good.subarray(0, 6)]));
  assert.equal(frames.length, 1);
  assert.equal(rest.length, 6, 'the partial frame is kept for the next chunk');
});

test('headers longer than the frame do not read past the end', () => {
  const frame = event('messageStart', { role: 'assistant' });
  frame.writeUInt32BE(9999, 4); // claim the headers are enormous
  const decoded = decodeFrame(frame);
  assert.deepEqual(decoded.headers, {});
  assert.equal(decoded.payload.length, 0);
});

test('a non-JSON payload gives null rather than throwing', () => {
  const frame = decodeFrame(encodeFrame({ ':event-type': 'chunk' }, Buffer.from([0x00, 0xff, 0x10])));
  assert.equal(frameJson(frame), null);
  assert.equal(frameJson({ payload: Buffer.alloc(0) }), null);
  assert.equal(frameJson(null), null);
});

test('an empty buffer is not an error', () => {
  const { frames, rest } = splitFrames(Buffer.alloc(0));
  assert.deepEqual(frames, []);
  assert.equal(rest.length, 0);
});
