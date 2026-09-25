// §23 — a QR code, as a grid of booleans.
//
// No dependency, because the budget is spent on SQLite, and because a QR
// encoder is a closed problem: the standard specifies exactly one correct
// output for a given payload, version, level and mask.
//
// Rendering is deliberately not here. This returns a matrix; the caller decides
// whether that becomes SVG in a browser or blocks in a terminal.

import { encodeToCodewords } from './encode.mjs';
import {
  Matrix, placeFunctionPatterns, placeCodewords, applyMask,
  penalty, placeFormat, placeVersion, MASKS
} from './matrix.mjs';

export { MASKS } from './matrix.mjs';

/**
 * Encode `text` as a QR symbol.
 *
 * Every mask is tried and the lowest-penalty one kept, which is what the
 * standard requires rather than an optimisation — the rules exist to avoid
 * patterns that defeat real scanners, and which mask avoids them depends
 * entirely on the data.
 */
export function encode(text, { level = 'M', version = null, mask = null } = {}) {
  const encoded = encodeToCodewords(text, { level, version });

  let best = null;
  const candidates = mask === null ? MASKS.map((_, index) => index) : [mask];

  for (const candidate of candidates) {
    const matrix = new Matrix(encoded.version);
    placeFunctionPatterns(matrix);
    placeCodewords(matrix, encoded.codewords);
    applyMask(matrix, candidate);
    placeFormat(matrix, level, candidate);
    placeVersion(matrix);

    const score = penalty(matrix);
    if (best === null || score < best.score) best = { matrix, score, mask: candidate };
  }

  return {
    modules: best.matrix.toRows(),
    size: best.matrix.size,
    version: encoded.version,
    level,
    mask: best.mask,
    penalty: best.score
  };
}

/**
 * The symbol as text, two characters per module so it comes out square in a
 * terminal, with the quiet zone the standard requires.
 *
 * Without four modules of quiet zone many scanners will not see the symbol at
 * all, which looks like a broken encoder rather than a missing margin.
 */
export function toText(qr, { dark = '██', light = '  ', quiet = 4 } = {}) {
  const width = qr.size + quiet * 2;
  const blank = light.repeat(width);
  const lines = [];

  for (let i = 0; i < quiet; i++) lines.push(blank);
  for (const row of qr.modules) {
    lines.push(light.repeat(quiet) + row.map((m) => (m ? dark : light)).join('') + light.repeat(quiet));
  }
  for (let i = 0; i < quiet; i++) lines.push(blank);

  return lines.join('\n');
}

/**
 * The symbol as an SVG path, one `<path>` for every dark module merged into a
 * single `d` attribute — a rect per module would be several thousand elements
 * for a symbol this size.
 */
export function toSvg(qr, { scale = 4, quiet = 4, dark = '#14161a', light = '#ffffff' } = {}) {
  const size = (qr.size + quiet * 2) * scale;
  const parts = [];

  qr.modules.forEach((row, y) => {
    row.forEach((module, x) => {
      if (module) parts.push(`M${(x + quiet) * scale} ${(y + quiet) * scale}h${scale}v${scale}h-${scale}z`);
    });
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">`,
    `<rect width="${size}" height="${size}" fill="${light}"/>`,
    `<path fill="${dark}" d="${parts.join('')}"/>`,
    '</svg>'
  ].join('');
}
