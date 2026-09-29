// The redraw throttle behind the timeline banners.
import test from 'node:test';
import assert from 'node:assert/strict';
import { throttled } from '../ui/dom.js';

test('the first call goes straight through', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const seen = [];
  const run = throttled(1000, (v) => seen.push(v));

  run('a');
  assert.deepEqual(seen, ['a'], 'a throttle that delays the first call feels broken');
});

test('a burst collapses to the first and the last', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const seen = [];
  const run = throttled(1000, (v) => seen.push(v));

  run('a');
  run('b');
  run('c');
  run('d');
  assert.deepEqual(seen, ['a'], 'still inside the window');

  t.mock.timers.tick(1000);
  assert.deepEqual(seen, ['a', 'd'], 'the last state is what the banner should end up showing');
});

test('nothing fires again when nothing was queued', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let calls = 0;
  const run = throttled(1000, () => calls++);

  run();
  t.mock.timers.tick(5000);
  assert.equal(calls, 1, 'a quiet window must not produce a phantom redraw');
});

test('a call after the window goes straight through again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const seen = [];
  const run = throttled(1000, (v) => seen.push(v));

  run('a');
  t.mock.timers.tick(1500);
  run('b');
  assert.deepEqual(seen, ['a', 'b']);
});

test('one timer serves a whole burst', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const seen = [];
  const run = throttled(100, (v) => seen.push(v));

  run(0);
  for (let i = 1; i <= 50; i++) run(i);
  t.mock.timers.tick(100);

  assert.deepEqual(seen, [0, 50], 'fifty queued timers would each fire');
});
