// The landing page is a third list of what orangebox does. It has already
// drifted once — it still advertised v1.0.0 four releases later — so it gets
// the same treatment as the README.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('the site states the version that is actually shipping', () => {
  const { version } = JSON.parse(read('package.json'));
  assert.match(read('docs/index.html'), new RegExp(`orangebox v${version.replace(/\./g, '\.')}`));
});

test('the sections are numbered in order, with none repeated or skipped', () => {
  const numbers = [...read('docs/index.html').matchAll(/eyebrow">§(\d+) ·/g)].map((m) => Number(m[1]));
  assert.ok(numbers.length >= 6, `only found ${numbers.length} sections`);
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1));
});

test('the site links to the repository it lives in', () => {
  const site = read('docs/index.html');
  const { repository } = JSON.parse(read('package.json'));
  const slug = String(repository.url).match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
  assert.ok(slug, 'package.json has no github repository url to check against');
  assert.ok(site.includes(`github.com/${slug}`), `the site does not link to ${slug}`);
});

test('every image the site references exists', () => {
  // A broken image on the landing page is the first thing a visitor sees, and
  // the last thing anybody thinks to check after renaming a file.
  const site = read('docs/index.html');
  for (const [, src] of site.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    if (src.startsWith('http') || src.startsWith('data:')) continue;
    assert.ok(
      fs.existsSync(new URL(`../docs/${src}`, import.meta.url)),
      `docs/index.html references ${src}, which does not exist`
    );
  }
});

test('every image on the site has alt text a screen reader can use', () => {
  const site = read('docs/index.html');
  const images = [...site.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(images.length > 0);
  for (const tag of images) {
    const alt = tag.match(/\salt="([^"]*)"/);
    assert.ok(alt, `an <img> has no alt attribute: ${tag.slice(0, 80)}`);
    assert.ok(alt[1].length > 12, `alt text is too thin to be useful: "${alt[1]}"`);
  }
});
