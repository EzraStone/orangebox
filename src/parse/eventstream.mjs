// §07 — AWS event-stream (vnd.amazon.eventstream), the binary framing Bedrock
// uses for ConverseStream. Anthropic, OpenAI and Gemini all stream text/SSE;
// Bedrock is the one that does not, which is the whole reason this file exists.
//
// Frame layout, all integers big-endian:
//
//   uint32  total length      (the whole frame, including this field)
//   uint32  headers length
//   uint32  prelude CRC32     (over the 8 bytes above)
//   ...     headers
//   ...     payload           (total - headers - 16)
//   uint32  message CRC32     (over everything before it)
//
// Each header is:
//
//   uint8   name length
//   bytes   name
//   uint8   value type
//   ...     value, shaped by the type
//
// Bedrock only ever sends type 7 (string) headers in practice — ":event-type",
// ":content-type", ":message-type" — but the other types are decoded so an
// unexpected one advances the cursor correctly instead of desynchronising the
// rest of the buffer.

const PRELUDE_BYTES = 12; // two lengths plus the prelude CRC
const TRAILER_BYTES = 4; // message CRC

/** Header value types, by the wire's numbering. */
const TYPE = {
  BOOL_TRUE: 0,
  BOOL_FALSE: 1,
  BYTE: 2,
  SHORT: 3,
  INTEGER: 4,
  LONG: 5,
  BYTE_ARRAY: 6,
  STRING: 7,
  TIMESTAMP: 8,
  UUID: 9
};

/**
 * Split a buffer into whole frames.
 *
 * Returns { frames, rest } — `rest` is the trailing bytes of a frame that has
 * not finished arriving, which the caller feeds back in with the next chunk.
 * Nothing here throws: a malformed length is treated as the end of the usable
 * buffer, because losing the record of a broken stream is worse than losing
 * the tail of it.
 */
export function splitFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + PRELUDE_BYTES <= buffer.length) {
    const total = buffer.readUInt32BE(offset);

    // A frame has to be at least a prelude plus a trailer. Anything smaller,
    // or absurdly large, means we are not looking at a frame boundary and
    // there is no safe way to resynchronise.
    if (total < PRELUDE_BYTES + TRAILER_BYTES || total > 64 * 1024 * 1024) break;
    if (offset + total > buffer.length) break; // not all here yet

    frames.push(decodeFrame(buffer.subarray(offset, offset + total)));
    offset += total;
  }

  return { frames, rest: buffer.subarray(offset) };
}

/**
 * One frame to { headers, payload }.
 *
 * The two CRC32s go unchecked, deliberately. orangebox is watching a stream the
 * real client is parsing at the same time; if a checksum were wrong the client
 * would fail on its own, and refusing to record would destroy the evidence of
 * exactly the failure someone opened orangebox to look at (§14.1).
 */
export function decodeFrame(frame) {
  const headersLength = frame.readUInt32BE(4);
  const headersStart = PRELUDE_BYTES;
  const headersEnd = headersStart + headersLength;
  const payloadEnd = frame.length - TRAILER_BYTES;

  if (headersEnd > payloadEnd) return { headers: {}, payload: Buffer.alloc(0) };

  return {
    headers: decodeHeaders(frame.subarray(headersStart, headersEnd)),
    payload: frame.subarray(headersEnd, payloadEnd)
  };
}

function decodeHeaders(buffer) {
  const headers = {};
  let offset = 0;

  while (offset < buffer.length) {
    const nameLength = buffer.readUInt8(offset);
    offset += 1;
    if (offset + nameLength > buffer.length) break;

    const name = buffer.toString('utf8', offset, offset + nameLength);
    offset += nameLength;
    if (offset >= buffer.length) break;

    const type = buffer.readUInt8(offset);
    offset += 1;

    const read = readValue(buffer, offset, type);
    if (!read) break; // unknown type: the cursor is unreliable from here on
    headers[name] = read.value;
    offset = read.offset;
  }

  return headers;
}

function readValue(buffer, offset, type) {
  const has = (n) => offset + n <= buffer.length;

  switch (type) {
    case TYPE.BOOL_TRUE:
      return { value: true, offset };
    case TYPE.BOOL_FALSE:
      return { value: false, offset };
    case TYPE.BYTE:
      return has(1) ? { value: buffer.readInt8(offset), offset: offset + 1 } : null;
    case TYPE.SHORT:
      return has(2) ? { value: buffer.readInt16BE(offset), offset: offset + 2 } : null;
    case TYPE.INTEGER:
      return has(4) ? { value: buffer.readInt32BE(offset), offset: offset + 4 } : null;
    case TYPE.LONG:
    case TYPE.TIMESTAMP: {
      if (!has(8)) return null;
      // Number, not BigInt: these are timestamps and counters, and a BigInt
      // would leak out into JSON.stringify and throw there instead of here.
      return { value: Number(buffer.readBigInt64BE(offset)), offset: offset + 8 };
    }
    case TYPE.BYTE_ARRAY:
    case TYPE.STRING: {
      if (!has(2)) return null;
      const length = buffer.readUInt16BE(offset);
      const start = offset + 2;
      if (start + length > buffer.length) return null;
      const slice = buffer.subarray(start, start + length);
      return {
        value: type === TYPE.STRING ? slice.toString('utf8') : slice.toString('base64'),
        offset: start + length
      };
    }
    case TYPE.UUID:
      return has(16) ? { value: buffer.toString('hex', offset, offset + 16), offset: offset + 16 } : null;
    default:
      return null;
  }
}

/** The JSON body of a frame, or null when it is not JSON at all. */
export function frameJson(frame) {
  if (!frame?.payload?.length) return null;
  try {
    return JSON.parse(frame.payload.toString('utf8'));
  } catch {
    return null;
  }
}

/** Build a frame. Only used by the tests — nothing in orangebox writes these. */
export function encodeFrame(headers, payload) {
  const parts = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const valueBuf = Buffer.from(String(value), 'utf8');
    const head = Buffer.alloc(1 + nameBuf.length + 1 + 2);
    head.writeUInt8(nameBuf.length, 0);
    nameBuf.copy(head, 1);
    head.writeUInt8(TYPE.STRING, 1 + nameBuf.length);
    head.writeUInt16BE(valueBuf.length, 2 + nameBuf.length);
    parts.push(head, valueBuf);
  }

  const headerBuf = Buffer.concat(parts);
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const total = PRELUDE_BYTES + headerBuf.length + body.length + TRAILER_BYTES;

  const frame = Buffer.alloc(total);
  frame.writeUInt32BE(total, 0);
  frame.writeUInt32BE(headerBuf.length, 4);
  frame.writeUInt32BE(0, 8); // prelude CRC — unchecked on the way back in
  headerBuf.copy(frame, PRELUDE_BYTES);
  body.copy(frame, PRELUDE_BYTES + headerBuf.length);
  frame.writeUInt32BE(0, total - TRAILER_BYTES);
  return frame;
}
