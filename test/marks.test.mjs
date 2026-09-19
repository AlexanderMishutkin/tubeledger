// The remembered marks: what survives a browser restart, what fades, and what
// the store gives away about what was watched (nothing, is the intent).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprint, lookupMark, putMark, touchMark, forgetMark, pruneMarks, countMarks,
  MARK_MAX, MARK_TTL_MS,
} from '../src/lib/marks.js';

const DAY = 86400000;

test('a mark comes back for the video it was made on', async () => {
  const fp = await fingerprint('dQw4w9WgXcQ');
  const marks = putMark({}, fp, 'work');
  assert.equal(lookupMark(marks, fp), 'work');
  assert.equal(lookupMark(marks, await fingerprint('other-video')), null);
});

test('marking again moves the mark rather than adding one', async () => {
  const fp = await fingerprint('abc');
  let marks = putMark({}, fp, 'work');
  marks = putMark(marks, fp, 'ent');
  assert.equal(countMarks(marks), 1);
  assert.equal(lookupMark(marks, fp), 'ent');
});

test('the fingerprint is stable, short, and not the id', async () => {
  const fp = await fingerprint('dQw4w9WgXcQ');
  assert.equal(fp, await fingerprint('dQw4w9WgXcQ'));
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.ok(!fp.includes('dQw4w9WgXcQ'));
  assert.notEqual(fp, await fingerprint('dQw4w9WgXcR'));
});

test('a mark nobody has come back to fades', async () => {
  const fp = await fingerprint('abc');
  const now = Date.now();
  const marks = putMark({}, fp, 'work', now - MARK_TTL_MS - 1);
  assert.equal(lookupMark(marks, fp, now), null);
  assert.equal(countMarks(marks, now), 0);
  assert.deepEqual(pruneMarks(marks, now), {});
});

test('seeing a video again keeps its mark alive', async () => {
  const fp = await fingerprint('abc');
  const now = Date.now();
  let marks = putMark({}, fp, 'work', now - MARK_TTL_MS + DAY);
  marks = touchMark(marks, fp, now);
  assert.equal(lookupMark(marks, fp, now + MARK_TTL_MS - DAY), 'work');
});

test('only the most recently seen marks are kept', () => {
  const now = Date.now();
  let marks = {};
  for (let i = 0; i < MARK_MAX + 50; i += 1) {
    // Oldest first, so the first fifty are the ones that should fall out.
    marks = putMark(marks, `fp${i}`, 'work', now - (MARK_MAX + 50 - i) * 1000);
  }
  assert.equal(countMarks(marks, now), MARK_MAX);
  assert.equal(lookupMark(marks, 'fp0', now), null);
  assert.equal(lookupMark(marks, 'fp49', now), null);
  assert.equal(lookupMark(marks, 'fp50', now), 'work');
  assert.equal(lookupMark(marks, `fp${MARK_MAX + 49}`, now), 'work');
});

test('taking a judgement back leaves nothing behind', async () => {
  const fp = await fingerprint('abc');
  const marks = forgetMark(putMark({}, fp, 'work'), fp);
  assert.deepEqual(marks, {});
  assert.equal(lookupMark(marks, fp), null);
});

test('putting a mark does not mutate the store it was given', async () => {
  const fp = await fingerprint('abc');
  const before = {};
  putMark(before, fp, 'work');
  assert.deepEqual(before, {});
});
