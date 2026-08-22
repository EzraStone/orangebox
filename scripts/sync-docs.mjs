#!/usr/bin/env node
// docs/spec.html is a published copy of the canonical orangebox-spec.html at
// the repo root. Two copies of anything drift; this makes the drift loud.
//
//   node scripts/sync-docs.mjs           refresh the copy
//   node scripts/sync-docs.mjs --check   fail if it is stale (used by CI)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'orangebox-spec.html');
const COPY = path.join(ROOT, 'docs', 'spec.html');

const digest = (file) =>
  fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;

const check = process.argv.includes('--check');
const source = digest(SOURCE);

if (source === null) {
  console.error(`sync-docs: ${path.relative(ROOT, SOURCE)} is missing`);
  process.exit(1);
}

if (digest(COPY) === source) {
  console.log('docs/spec.html matches the canonical spec');
  process.exit(0);
}

if (check) {
  console.error(
    'docs/spec.html is out of date.\n' +
      'The spec at the repo root is canonical — run `npm run docs:sync` and commit the result.'
  );
  process.exit(1);
}

fs.copyFileSync(SOURCE, COPY);
console.log('docs/spec.html refreshed from orangebox-spec.html');
