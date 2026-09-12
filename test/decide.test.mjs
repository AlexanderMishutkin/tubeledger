import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/lib/decide.js';

const tab = (over = {}) => ({
  playing: false, visible: false, focused: false, category: 'ent', ...over,
});

test('nothing playing in a hidden tab counts as nothing', () => {
  assert.equal(decide([tab({ playing: false, visible: false })]), null);
  assert.equal(decide([]), null);
});

test('watching in the front tab books its category, in the foreground', () => {
  const r = decide([tab({ playing: true, visible: true, focused: true, category: 'work' })]);
  assert.deepEqual(r, { c: 'work', bg: false });
});

test('browsing the front tab books menu time', () => {
  const r = decide([tab({ playing: false, visible: true, focused: true })]);
  assert.deepEqual(r, { c: 'menu', bg: false });
});

test('playing in a hidden tab still counts, flagged as background', () => {
  const r = decide([tab({ playing: true, visible: false, category: 'ent' })]);
  assert.deepEqual(r, { c: 'ent', bg: true });
});

test('background playback can be switched off', () => {
  const r = decide([tab({ playing: true, visible: false })], { countBackground: false });
  assert.equal(r, null);
});

test('an unfocused window is background even while the tab is visible', () => {
  const r = decide([tab({ playing: true, visible: true, focused: false, category: 'work' })]);
  assert.deepEqual(r, { c: 'work', bg: true });
});

test('what you are looking at beats what is merely audible', () => {
  const r = decide([
    tab({ playing: true, visible: false, category: 'ent' }),
    tab({ playing: true, visible: true, focused: true, category: 'work' }),
  ]);
  assert.deepEqual(r, { c: 'work', bg: false });
});

test('only one tab is ever counted, so two players cannot double-bill', () => {
  const r = decide([
    tab({ playing: true, visible: false, category: 'ent' }),
    tab({ playing: true, visible: false, category: 'work' }),
  ]);
  assert.deepEqual(r, { c: 'ent', bg: true });
});

test('going idle stops menu time but never stops a running video', () => {
  const browsing = decide([tab({ playing: false, visible: true, focused: true })], { idleState: 'idle' });
  assert.equal(browsing, null);
  const watching = decide([tab({ playing: true, visible: true, focused: true })], { idleState: 'idle' });
  assert.deepEqual(watching, { c: 'ent', bg: false });
});

test('a locked screen demotes even a playing front tab to background', () => {
  const r = decide([tab({ playing: true, visible: true, focused: true })], { idleState: 'locked' });
  assert.deepEqual(r, { c: 'ent', bg: true });
});

test('an uncategorised tab books yellow, not entertainment', () => {
  const front = decide([tab({ playing: true, visible: true, focused: true, category: 'unset' })]);
  assert.deepEqual(front, { c: 'menu', bg: false });
  const back = decide([tab({ playing: true, visible: false, category: 'unset' })]);
  assert.deepEqual(back, { c: 'menu', bg: true });
});

test('a tab with no category of its own inherits the default', () => {
  const r = decide([tab({ playing: true, visible: true, focused: true, category: null })], { defaultCategory: 'work' });
  assert.deepEqual(r, { c: 'work', bg: false });
});
