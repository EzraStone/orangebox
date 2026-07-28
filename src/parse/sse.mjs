// Shared SSE framing for the two provider parsers (§07). Not in the §15 file
// list, but duplicating the wire-format splitter in both modules would be worse
// than one twenty-line helper.

/**
 * Split a captured `text/event-stream` transcript into { event, data } frames.
 * Tolerant by design: unterminated trailing frames, CRLF, comment lines, and
 * multi-line data fields all round-trip without throwing (§07).
 */
export function parseSseFrames(text) {
  const frames = [];
  if (typeof text !== 'string' || text === '') return frames;

  for (const block of text.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    let event = null;
    const dataLines = [];

    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue; // blank or heartbeat comment
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }

    if (dataLines.length > 0) frames.push({ event, data: dataLines.join('\n') });
  }

  return frames;
}

/** JSON.parse that yields null instead of throwing on a malformed frame. */
export function parseFrameJson(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
