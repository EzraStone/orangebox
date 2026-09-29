// §11.2 — the parts of the UI a keyboard has to be able to reach.
//
// These are read out of the source rather than driven in a browser: there is
// no DOM in the test runner and no dependency budget for one. They catch the
// class of mistake that actually happens here — a control that announces
// itself to assistive technology and then only answers a pointer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const shell = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8');

test('every button in the shell has a name a screen reader can announce', () => {
  // Either an aria-label, or text content that is not purely decorative. An
  // icon button whose only content is an entity reference reads as nothing.
  const buttons = [...shell.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.ok(buttons.length >= 10, `only found ${buttons.length} buttons to check`);

  for (const [whole, attrs, content] of buttons) {
    const labelled = /\saria-label="[^"]+"/.test(attrs);
    const spoken = content
      .replace(/<[^>]*aria-hidden[^>]*>[\s\S]*?<\/[^>]+>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&[#a-zA-Z0-9]+;/g, '')
      .trim();
    assert.ok(labelled || spoken.length > 0, `a button has no accessible name: ${whole.slice(0, 90)}`);
  }
});

test('every form control in the shell is labelled', () => {
  for (const tag of shell.match(/<(input|select)\b[^>]*>/g) ?? []) {
    if (/type="hidden"/.test(tag)) continue;
    assert.ok(/\saria-label="[^"]+"/.test(tag), `an input has no label: ${tag.slice(0, 90)}`);
  }
});

test('the resize separator is operable by keyboard, not only by pointer', () => {
  // A control with role="separator" tells assistive technology it can be
  // adjusted. Until it answered arrow keys, that was a claim and not a fact.
  const tag = shell.match(/<div class="drag"[\s\S]*?>/)?.[0];
  assert.ok(tag, 'the separator is missing from the shell');
  assert.match(tag, /role="separator"/);
  assert.match(tag, /tabindex="0"/);
  assert.match(tag, /aria-label="[^"]+"/);

  assert.match(app, /handle\.addEventListener\('keydown'/, 'the separator has no key handler');
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    assert.ok(app.includes(`'${key}'`), `the separator does not answer ${key}`);
  }
  assert.match(app, /aria-valuenow/, 'a separator that moves must report where it is');
});

test('focus is visible, and not only on hover', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:/);
  assert.match(css, /\.drag:focus-visible/, 'the separator draws no focus ring');
});

test('motion is optional', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('decorative glyphs are hidden from assistive technology', () => {
  // The mobile nav puts a symbol and a word in each button; the symbol is
  // decoration and reading it aloud is noise.
  const nav = shell.match(/<nav class="mobile-nav"[\s\S]*?<\/nav>/)?.[0] ?? '';
  const glyphs = nav.match(/<span>(?![A-Za-z])[^<]*<\/span>/g) ?? [];
  assert.equal(glyphs.length, 0, `a decorative glyph is not hidden: ${glyphs[0]}`);
});

test('the tablist is one tab stop, moved through with the arrow keys', () => {
  // Seven tab stops between a control and its contents is how a keyboard user
  // learns to route around a widget entirely.
  assert.match(app, /tabindex: selected \? '0' : '-1'/, 'every tab is still its own tab stop');
  assert.match(app, /function onTabKey\(/, 'the tablist has no key handler');
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.ok(app.includes(`event.key === '${key}'`), `the tablist does not answer ${key}`);
  }
});

test('each tab names the panel it controls, and the panel names its tab', () => {
  assert.match(app, /'aria-controls': 'tabpanel'/);
  assert.match(app, /panel\.setAttribute\('aria-labelledby', `tab-\$\{state\.tab\}`\)/);
});

test('the tabs keep their arrow keys to themselves', () => {
  // j/k and the arrow shortcuts move the timeline selection. Without
  // stopPropagation, arrowing between tabs would also move the call underneath
  // them, which is a genuinely disorienting thing to have happen.
  const handler = app.match(/function onTabKey\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(handler, /stopPropagation\(\)/);
});
