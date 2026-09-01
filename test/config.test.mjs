// §20 — the optional config file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, resolveSettings, compileRedactionRules } from '../src/config.mjs';

/** A stand-in filesystem, so no test writes to a real home directory. */
const fakeFs = (contents) => ({
  readFileSync(file) {
    if (!Object.hasOwn(contents, file)) {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return contents[file];
  }
});

test('a missing config file is the normal case, not an error', () => {
  const result = loadConfig({ file: '/nowhere/config.json', fs: fakeFs({}) });
  assert.deepEqual(result.config, {});
  assert.equal(result.present, false);
  assert.deepEqual(result.errors, []);
});

test('valid settings are read', () => {
  const result = loadConfig({
    file: '/c.json',
    fs: fakeFs({ '/c.json': JSON.stringify({ port: 5000, gap: 300, open: false, db: '/tmp/x.db' }) })
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.config.port, 5000);
  assert.equal(result.config.gap, 300);
  assert.equal(result.config.open, false);
});

test('a malformed file reports and falls back rather than refusing to start', () => {
  // Failing to boot because of a stray comma in a file the user may not
  // remember writing is a worse outcome than starting with defaults and
  // saying so loudly.
  const result = loadConfig({ file: '/c.json', fs: fakeFs({ '/c.json': '{ port: 5000, }' }) });
  assert.deepEqual(result.config, {});
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /not valid JSON/);
});

test('an unknown setting is reported, not silently ignored', () => {
  // A typo'd key that quietly does nothing is the worst of the three
  // outcomes — the user believes the setting is applied.
  const result = loadConfig({
    file: '/c.json',
    fs: fakeFs({ '/c.json': JSON.stringify({ prot: 5000, port: 4100 }) })
  });
  assert.equal(result.config.port, 4100, 'the valid setting still applies');
  assert.match(result.errors[0], /unknown setting "prot"/);
});

test('a setting of the wrong type is rejected by name', () => {
  const result = loadConfig({
    file: '/c.json',
    fs: fakeFs({ '/c.json': JSON.stringify({ port: 'four thousand', gap: 60 }) })
  });
  assert.equal(result.config.gap, 60, 'the other settings survive');
  assert.equal(result.config.port, undefined);
  assert.match(result.errors[0], /"port" must be a port number/);
});

test('keys starting with an underscore are comments', () => {
  const result = loadConfig({
    file: '/c.json',
    fs: fakeFs({ '/c.json': JSON.stringify({ _comment: 'why this exists', port: 4100 }) })
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.config.port, 4100);
});

test('an upstream must be an http url', () => {
  const ok = loadConfig({
    file: '/c.json',
    fs: fakeFs({ '/c.json': JSON.stringify({ upstreams: { gemini: 'http://127.0.0.1:9' } }) })
  });
  assert.equal(ok.config.upstreams.gemini, 'http://127.0.0.1:9');

  const bad = loadConfig({
    file: '/c.json',
    fs: fakeFs({ '/c.json': JSON.stringify({ upstreams: { gemini: 'ftp://x' } }) })
  });
  assert.match(bad.errors[0], /upstreams\.gemini/);
});

test('a flag always beats the config file, which beats the default', () => {
  const settings = resolveSettings({
    defaults: { port: 4100, gap: 120, host: '127.0.0.1' },
    config: { port: 5000, gap: 300 },
    flags: { port: 6000 }
  });
  assert.equal(settings.port, 6000, 'the flag wins');
  assert.equal(settings.gap, 300, 'the file wins over the default');
  assert.equal(settings.host, '127.0.0.1', 'the default survives');
});

test('an unset flag does not override the file', () => {
  // The distinction that matters: "not typed" is undefined, not a value.
  const settings = resolveSettings({
    defaults: { port: 4100 },
    config: { port: 5000 },
    flags: { port: undefined }
  });
  assert.equal(settings.port, 5000);
});
