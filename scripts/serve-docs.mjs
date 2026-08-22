#!/usr/bin/env node
// Serve docs/ for a local look at the website before it ships.
//
//   npm run docs:serve
//
// This used to be a 400-character `node -e` crammed into package.json, which
// nobody could read and nobody would have dared edit.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const PORT = Number(process.env.PORT ?? 4190);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

http
  .createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';

    const file = path.resolve(path.join(ROOT, rel));
    // Never serve outside docs/, however creative the path.
    if (!file.startsWith(path.resolve(ROOT)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }

    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`docs on http://127.0.0.1:${PORT}`);
  });
