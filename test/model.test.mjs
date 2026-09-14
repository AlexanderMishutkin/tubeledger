import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKey, dayBounds, shiftDay, dayRange, splitByDay, totals, mergeAdjacent,
  fmtDuration, normalize, remindBucket,
} from '../src/lib/model.js';

const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();

test('a day runs 04:00 -> 04:00, so late-night viewing stays on the evening before', () => {
  assert.equal(dayKey(at(2026, 9, 12, 23, 30)), '2026-09-12');
  assert.equal(dayKey(at(2026, 9, 13, 2, 30)), '2026-09-12');
  assert.equal(dayKey(at(2026, 9, 13, 3, 59)), '2026-09-12');
  assert.equal(dayKey(at(2026, 9, 13, 4, 0)), '2026-09-13');
});

test('midnight day start still works when configured', () => {
  assert.equal(dayKey(at(2026, 9, 13, 2, 30), 0), '2026-09-13');
});

test('day bounds line up end-to-start with no gap', () => {
  const a = dayBounds('2026-09-12');
  const b = dayBounds('2026-09-13');
  assert.equal(a.end, b.start);
  assert.equal(new Date(a.start).getHours(), 4);
});

test('day bounds survive a DST shift (23- and 25-hour days)', () => {
  for (const key of ['2026-03-28', '2026-03-29', '2026-10-24', '2026-10-25']) {
    const { start, end } = dayBounds(key);
    assert.equal(new Date(start).getHours(), 4, `${key} starts at 04:00 local`);
    assert.equal(new Date(end).getHours(), 4, `${key} ends at 04:00 local`);
    const hours = (end - start) / 3600000;
    assert.ok(hours >= 23 && hours <= 25, `${key} spans ${hours}h`);
  }
});

test('shiftDay and dayRange walk calendar days', () => {
  assert.equal(shiftDay('2026-02-28', 1), '2026-03-01'); // 2026 is not a leap year
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
  assert.deepEqual(dayRange('2026-09-10', '2026-09-12'), ['2026-09-10', '2026-09-11', '2026-09-12']);
});

test('a session running through 04:00 is split across both days', () => {
  const seg = { id: 'x', c: 'ent', bg: 0, s: at(2026, 9, 13, 3, 30), e: at(2026, 9, 13, 5, 0) };
  const parts = splitByDay(seg);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].key, '2026-09-12');
  assert.equal(parts[1].key, '2026-09-13');
  assert.equal(parts[0].seg.e, parts[1].seg.s);
  const total = parts.reduce((sum, p) => sum + (p.seg.e - p.seg.s), 0);
  assert.equal(total, seg.e - seg.s);
});

test('totals split by class and by foreground/background', () => {
  const t = totals([
    { c: 'ent', bg: 0, s: 0, e: 600000 },
    { c: 'ent', bg: 1, s: 600000, e: 900000 },
    { c: 'work', bg: 0, s: 900000, e: 1500000 },
    { c: 'menu', bg: 0, s: 1500000, e: 1560000 },
  ]);
  assert.equal(t.ent, 900000);
  assert.equal(t.work, 600000);
  assert.equal(t.menu, 60000);
  assert.equal(t.total, 1560000);
  assert.equal(t.bg, 300000);
  assert.equal(t.fg, 1260000);
  assert.equal(t.byKind.ent_bg, 300000);
  assert.equal(t.byKind.ent_fg, 600000);
});

test('adjacent ticks of the same kind merge into one session', () => {
  const merged = mergeAdjacent([
    { id: 'a', c: 'ent', bg: 0, s: 0, e: 5000 },
    { id: 'b', c: 'ent', bg: 0, s: 5000, e: 10000 },
    { id: 'c', c: 'ent', bg: 1, s: 10000, e: 15000 },
    { id: 'd', c: 'ent', bg: 1, s: 60000, e: 65000 },
  ]);
  assert.equal(merged.length, 3);
  assert.deepEqual([merged[0].s, merged[0].e], [0, 10000]);
  assert.equal(merged[1].bg, 1);
  assert.equal(merged[2].s, 60000); // a minute of silence is a new session
});

test('hand-edited entries are never swallowed by a merge', () => {
  const merged = mergeAdjacent([
    { id: 'a', c: 'work', bg: 0, s: 0, e: 5000 },
    { id: 'b', c: 'work', bg: 0, s: 5000, e: 10000, man: 1 },
  ]);
  assert.equal(merged.length, 2);
});

test('normalize drops empty and unknown-class segments', () => {
  const clean = normalize([
    { id: 'a', c: 'ent', bg: 0, s: 10, e: 10 },
    { id: 'b', c: 'nope', bg: 0, s: 0, e: 10 },
    { id: 'c', c: 'work', bg: 0, s: 20, e: 30 },
    { id: 'd', c: 'menu', bg: 0, s: 0, e: 10 },
  ]);
  assert.deepEqual(clean.map((s) => s.id), ['d', 'c']);
});

test('durations read the way a human writes them', () => {
  assert.equal(fmtDuration(45000), '45s');
  assert.equal(fmtDuration(90000), '1m'); // whole minutes down, like a stopwatch
  assert.equal(fmtDuration(3900000), '1h 05m');
  assert.equal(fmtDuration(3600000), '1h'); // no dangling "00m"
});

test('reminder steps change exactly on the round figures', () => {
  const five = 5 * 60000;
  assert.equal(remindBucket(60 * 60000, five), 12, 'a full hour is step 12');
  assert.equal(remindBucket(55 * 60000 + 1000, five), 12, 'a second above 55m is still step 12');
  assert.equal(remindBucket(55 * 60000, five), 11, 'crossing 55m drops a step');
  assert.equal(remindBucket(45 * 60000, five), 9);
  assert.equal(remindBucket(0, five), 0);
  assert.equal(remindBucket(-1000, five), 0, 'past the limit is not a negative step');
  assert.equal(remindBucket(10 * 60000, 0), null, 'reminders off');
  // The figure announced is the step times the interval: a round number.
  assert.equal(remindBucket(45 * 60000, five) * five, 45 * 60000);
});
