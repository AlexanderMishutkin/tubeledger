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
  backupEnabled: true,    // keep a copy of the ledger in a folder you choose
  carryEnabled: true,     // overtime becomes tomorrow's debt, thrift becomes bonus
  carryShare: 2 / 3,      // how much of what you did not spend is banked
  rememberMarks: true,    // a video you marked comes back marked, browser restarts included
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
export function stackParts(dayTotals, order, limitMs, carry = NO_CARRY) {
  const parts = [];
  let cursor = 0;
  for (const c of order) {
    if (c === 'ent') {
      // Entertainment is not one block: it is debt, then budget, then bank, then over.
      for (const band of entBands(dayTotals.ent || 0, limitMs > 0 ? carry : NO_CARRY, limitMs)) {
        parts.push({ c: band.c, ms: band.ms, from: cursor });
        cursor += band.ms;
      }
      continue;
    }
    const ms = dayTotals[c] || 0;
    if (ms <= 0) continue;
    parts.push({ c, ms, from: cursor });
    cursor += ms;
  }
  return parts;
}

// ------------------------------------------------------------ the economy
//
// Going over does not just get logged, it gets *charged*: overtime is carried
// into the next day as entertainment time already spent. Restraint earns the
// mirror image — a share of what you did not spend is banked as bonus time.
//
// Two consequences worth stating, because they are the whole point:
//   · a binge is not free; it is borrowed from tomorrow
//   · the bank cannot grow forever. Banking `share` of what is left would settle
//     on limit · share/(1-share) by itself, but that is an asymptote, not a
//     promise; the bank is capped outright instead, so the ceiling a timer can
//     ever show is exactly limit + limit. A month away buys a 2h evening.

export const NO_CARRY = Object.freeze({ debt: 0, bonus: 0 });

/**
 * Debt is capped at this many times the daily limit. Without a cap it compounds:
 * a few heavy days and the budget is permanently spent, which does not deter
 * anything — it just gets the extension switched off. Two days' worth still
 * makes an evening expensive while leaving a way back.
 */
export const MAX_DEBT_MULT = 2;

/**
 * The bank is capped at this many times the daily limit, which fixes the ceiling
 * any timer can show at (1 + MAX_BONUS_MULT) · limit — two hours on a one-hour
 * limit. A saved-up evening should be a little longer than usual, not a
 * different kind of evening.
 */
export const MAX_BONUS_MULT = 1;

/**
 * What a finished day hands to the next one.
 * Debt and bonus are mutually exclusive: a day ends either over or under.
 */
export function carryForward(entMs, carryIn = NO_CARRY, limitMs = 0, share = DEFAULT_SETTINGS.carryShare) {
  const allowance = limitMs + (carryIn.bonus || 0);
  const charged = Math.max(0, entMs) + (carryIn.debt || 0);
  const left = allowance - charged;
  if (left >= 0) {
    return { debt: 0, bonus: Math.min(Math.round(left * share), limitMs * MAX_BONUS_MULT) };
  }
  return { debt: Math.min(-left, limitMs * MAX_DEBT_MULT), bonus: 0 };
}

/**
 * The carry for every day from the first tracked one up to `toKey`, walked
 * forward. Days with no data are not skipped — a day away from YouTube is a day
 * that spent nothing, and it earns like one.
 *
 * Derived, never accumulated: editing a day three weeks back re-runs the chain
 * from there, so the ledger cannot drift away from the entries it came from.
 */
export function carryChain(entByDay, toKey, limitMs, share = DEFAULT_SETTINGS.carryShare) {
  const keys = Object.keys(entByDay).sort();
  const out = {};
  if (!keys.length) return out;
  let carry = { ...NO_CARRY };
  for (const key of dayRange(keys[0], toKey)) {
    out[key] = carry;
    carry = carryForward(entByDay[key] || 0, carry, limitMs, share);
  }
  return out;
}

/** What today's ceiling actually is, once yesterday is taken into account. */
export function allowanceFor(carry, limitMs) {
  return limitMs + ((carry && carry.bonus) || 0);
}

/** Entertainment charged to today: what was watched, plus what was owed. */
export function chargedFor(entMs, carry) {
  return Math.max(0, entMs) + ((carry && carry.debt) || 0);
}

export function remainingFor(entMs, carry, limitMs) {
  return allowanceFor(carry, limitMs) - chargedFor(entMs, carry);
}

/**
 * One day's entertainment, cut into the bands the chart draws, bottom-up:
 *   debt   what yesterday's overtime already took   (brown)
 *   ent    watched, inside the base limit           (red)
 *   bonus  watched, inside banked time              (gold)
 *   over   watched past everything — tomorrow's debt (magenta)
 */
export function entBands(entMs, carry = NO_CARRY, limitMs = 0) {
  const bands = [];
  const debt = Math.max(0, (carry && carry.debt) || 0);
  const bonus = Math.max(0, (carry && carry.bonus) || 0);
  if (debt > 0) bands.push({ c: 'debt', ms: debt });

  let left = Math.max(0, entMs);
  if (!(limitMs > 0)) {
    // No limit configured: there is no line to be over, so it is all just time.
    if (left > 0) bands.push({ c: 'ent', ms: left });
    return bands;
  }
  let pos = debt;
  const take = (ceiling, name) => {
    const room = Math.max(0, ceiling - pos);
    const ms = Math.min(left, room);
    if (ms > 0) {
      bands.push({ c: name, ms });
      left -= ms;
      pos += ms;
    }
  };
  take(limitMs, 'ent');
  take(limitMs + bonus, 'bonus');
  if (left > 0) bands.push({ c: 'over', ms: left });
  return bands;
}

/**
 * How hard YouTube itself should lean on you, by how much budget is left.
 *   soft  under 20 minutes — long recommendations are filtered out
 *   hard  under 5 minutes  — nothing is offered at all until the tab is educational
 */
export const SOFT_MS = 20 * 60000;
export const HARD_MS = 5 * 60000;

export function restrictionFor(remainingMs) {
  if (remainingMs <= HARD_MS) return 'hard';
  if (remainingMs <= SOFT_MS) return 'soft';
  return 'none';
}

/** The longest recommendation worth offering with `remainingMs` left. */
export function maxSuggestedMs(remainingMs, factor = 1.9) {
  return Math.max(0, remainingMs) * factor;
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
