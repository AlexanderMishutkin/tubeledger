// Pure, dependency-free helpers shared by the service worker and the pages.
// Nothing in here touches chrome.* so it can be unit-tested under plain node.

/** Time classes. `menu` is "on YouTube but not attributed to work or fun":
 *  browsing, searching, a paused video, or playback with no category picked. */
export const CLASSES = ['work', 'ent', 'menu'];

export const CLASS_LABEL = {
  work: 'Work & education',
  ent: 'Entertainment',
  menu: 'Menu & browsing',
};

export const DEFAULT_SETTINGS = {
  dayStartHour: 4,        // a "day" runs 04:00 -> 04:00 local
  entLimitMin: 60,        // strict daily entertainment budget
  defaultCategory: 'ent', // category a fresh YouTube tab starts in: work | ent | unset
  countBackground: true,  // count playback in a hidden/unfocused tab
  idleSeconds: 60,        // no input for this long => stop counting menu time
  blockEnabled: true,     // pause entertainment playback once the limit is hit
  hudEnabled: true,       // show the corner indicator on YouTube itself
  remindEveryMin: 5,      // while watching entertainment, remind at each step of this
  backupEnabled: true,    // write a JSON backup to Downloads once a day
};

const DAY_MS = 86400000;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Local YYYY-MM-DD of the logical day that `ms` falls in. */
export function dayKey(ms, dayStartHour = DEFAULT_SETTINGS.dayStartHour) {
  const d = new Date(ms - dayStartHour * 3600000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** [start, end) of a logical day, in epoch ms. DST-safe: built from local fields. */
export function dayBounds(key, dayStartHour = DEFAULT_SETTINGS.dayStartHour) {
  const [y, m, d] = key.split('-').map(Number);
  const start = new Date(y, m - 1, d, dayStartHour, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d + 1, dayStartHour, 0, 0, 0).getTime();
  return { start, end };
}

/** Day key `n` days after `key` (negative for before). */
export function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12, 0, 0, 0);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** Every day key in [from, to], inclusive, oldest first. */
export function dayRange(from, to) {
  const out = [];
  let cur = from;
  for (let i = 0; i < 400 && cur <= to; i += 1) {
    out.push(cur);
    cur = shiftDay(cur, 1);
  }
  return out;
}

/**
 * Cut a raw interval on logical-day boundaries.
 * Returns [{ key, seg }, ...] so a session that runs through 04:00 lands in both days.
 */
export function splitByDay(seg, dayStartHour = DEFAULT_SETTINGS.dayStartHour) {
  const out = [];
  let s = seg.s;
  for (let i = 0; i < 400 && s < seg.e; i += 1) {
    const key = dayKey(s, dayStartHour);
    const { end } = dayBounds(key, dayStartHour);
    const e = Math.min(seg.e, end);
    out.push({ key, seg: { ...seg, s, e } });
    s = e;
  }
  return out;
}

/** Milliseconds per class, split foreground/background, plus a grand total. */
export function emptyTotals() {
  return {
    work: 0, ent: 0, menu: 0, total: 0, bg: 0, fg: 0,
    byKind: { work_fg: 0, work_bg: 0, ent_fg: 0, ent_bg: 0, menu_fg: 0, menu_bg: 0 },
  };
}

export function totals(segments) {
  const t = emptyTotals();
  for (const seg of segments) {
    const ms = Math.max(0, seg.e - seg.s);
    t[seg.c] = (t[seg.c] || 0) + ms;
    t.total += ms;
    if (seg.bg) t.bg += ms;
    else t.fg += ms;
    t.byKind[`${seg.c}_${seg.bg ? 'bg' : 'fg'}`] += ms;
  }
  return t;
}

/** Segments sorted by start, with zero/negative-length ones dropped. */
export function normalize(segments) {
  return segments
    .filter((s) => s && s.e > s.s && CLASSES.includes(s.c))
    .sort((a, b) => a.s - b.s);
}

/**
 * Glue adjacent same-kind segments together so storage holds sessions, not ticks.
 * `gapMs` is how much dead air is still considered the same stretch.
 */
export function mergeAdjacent(segments, gapMs = 2000) {
  const sorted = normalize(segments);
  const out = [];
  for (const seg of sorted) {
    const prev = out[out.length - 1];
    const sameKind = prev && prev.c === seg.c && !!prev.bg === !!seg.bg && !prev.man && !seg.man;
    if (sameKind && seg.s - prev.e <= gapMs) {
      prev.e = Math.max(prev.e, seg.e);
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

/** Ranges where two segments cover the same instant — surfaced as a warning, not an error. */
export function findOverlaps(segments) {
  const sorted = normalize(segments);
  const hits = [];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].s < sorted[i - 1].e) hits.push([sorted[i - 1].id, sorted[i].id]);
  }
  return hits;
}

/** "1h 04m", "2h", "12m", "48s" — compact enough for a badge or a table cell. */
export function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h}h ${pad(m)}m` : `${h}h`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/** "14:35" in local time. */
export function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local `YYYY-MM-DDTHH:MM` for <input type="datetime-local">. */
export function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Inverse of toLocalInput; NaN when the string is not a complete local timestamp. */
export function fromLocalInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || '');
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0).getTime();
}

/**
 * Lay a day out as a stack, bottom first, splitting entertainment at the limit so
 * the part that went over can be drawn in its own colour. Entertainment sits at
 * the bottom of the stack on purpose: it is the one measured against a line, and
 * a segment only reads against a line when it starts from the baseline.
 *
 * @returns {Array<{c:'ent'|'over'|'work'|'menu', ms:number, from:number}>} bottom-up
 */
export function stackParts(dayTotals, order, limitMs) {
  const parts = [];
  let cursor = 0;
  for (const c of order) {
    const ms = dayTotals[c] || 0;
    if (ms <= 0) continue;
    if (c === 'ent' && limitMs > 0 && ms > limitMs) {
      parts.push({ c: 'ent', ms: limitMs, from: cursor });
      cursor += limitMs;
      parts.push({ c: 'over', ms: ms - limitMs, from: cursor });
      cursor += ms - limitMs;
    } else {
      parts.push({ c, ms, from: cursor });
      cursor += ms;
    }
  }
  return parts;
}

/** The two files a backup writes: one always-current, one per month. */
export function backupFilenames(key) {
  return ['tubeledger-latest.json', `tubeledger-${key.slice(0, 7)}.json`];
}

/** A backup is due once per logical day — not once per launch, not once per tick. */
export function needsBackup(meta, todayKey) {
  return !meta || meta.lastDay !== todayKey;
}

/**
 * Which reminder step a remaining-budget sits in, counting down. Rounded up, so
 * the step changes exactly as the budget crosses a round figure: with a 5m
 * interval, 50m01s is still step 11 and 50m00s is step 10. A reminder is due
 * when this number drops, and `step * interval` is the round figure to announce.
 */
export function remindBucket(remainingMs, intervalMs) {
  if (!(intervalMs > 0)) return null;
  return Math.ceil(Math.max(0, remainingMs) / intervalMs);
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export { DAY_MS };
