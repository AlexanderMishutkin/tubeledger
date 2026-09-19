// Service worker: the accounting engine.
//
// Content scripts report what their tab is doing; this worker decides which
// single class of time is running right now, accrues it into one open segment,
// and flushes that segment to storage. Only one class can run at a time, so the
// ledger can never add up to more than wall-clock time.
import {
  DEFAULT_SETTINGS, dayKey, splitByDay, totals, emptyTotals, fmtDuration, remindBucket,
  allowanceFor, chargedFor, restrictionFor, NO_CARRY,
} from './lib/model.js';
import {
  getSettings, getDay, upsertSegment, newId, refreshCarry, carryOn,
  getMarks, saveMarks, clearMarks,
} from './lib/store.js';
import {
  fingerprint, lookupMark, putMark, touchMark, forgetMark, pruneMarks, countMarks,
} from './lib/marks.js';
import { decide } from './lib/decide.js';

const HEARTBEAT_MS = 5000;   // content scripts ping at this rate
const MAX_GAP_MS = 20000;    // a bigger jump means sleep/suspend: don't bill it
const FLUSH_MS = 15000;      // worst-case data loss if the browser dies

/** @type {Map<number, {playing:boolean, videoPage:boolean, visible:boolean, focused:boolean, category:string, from:string, video:string|null, fp:string|null}>} */
const tabs = new Map();
/** @type {Map<chrome.runtime.Port, number|null>} port -> tab it belongs to (null for pages) */
const ports = new Map();

let settings = { ...DEFAULT_SETTINGS };
let idleState = 'active';
let open = null;        // { id, s, e, c, bg, flushedTo }
let anchor = Date.now();
let lastFlush = 0;
let todayKey = dayKey(Date.now(), settings.dayStartHour);
let storedToday = emptyTotals();
let blocked = false;
let ticking = false;
let lastRemindBucket = null;
let carryToday = NO_CARRY;   // what yesterday left behind: debt owed, or time banked
let marks = {};              // fingerprint -> the category you gave that video

// ---------------------------------------------------------------- lifecycle

async function init() {
  settings = await getSettings();
  const stored = await getMarks();
  marks = pruneMarks(stored);
  // Only write back when the prune actually dropped something: the worker wakes
  // far too often for a storage write to be the price of waking up.
  if (Object.keys(marks).length !== Object.keys(stored).length) await saveMarks(marks);
  chrome.idle.setDetectionInterval(Math.max(15, settings.idleSeconds));
  idleState = await new Promise((r) => chrome.idle.queryState(Math.max(15, settings.idleSeconds), r));
  todayKey = dayKey(Date.now(), settings.dayStartHour);
  storedToday = totals(await getDay(todayKey));
  await refreshEconomy();
  anchor = Date.now();
  await refreshBadge();
}

chrome.runtime.onInstalled.addListener(() => { init(); });
chrome.runtime.onStartup.addListener(() => { init(); });

// A one-minute alarm is the backstop: it closes out a dangling segment when
// every YouTube tab is gone and nothing is pinging us any more.
chrome.alarms.create('tick', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async () => { await ready; await tick(); });

const ready = init();

// ------------------------------------------------------------------ inputs

chrome.idle.onStateChanged.addListener(async (state) => {
  await ready;
  idleState = state;
  await tick();
});

chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
  ports.set(port, tabId);

  port.onMessage.addListener(async (msg) => {
    await ready;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state' && tabId != null) {
      const prev = tabs.get(tabId);
      const video = typeof msg.videoId === 'string' && msg.videoId ? msg.videoId : null;
      // The category is only worked out again when the tab lands on a different
      // video; the other twelve messages a minute must not cost a hash and a read.
      const seen = prev && prev.video === video
        ? { category: prev.category, from: prev.from, fp: prev.fp }
        : await recall(tabId, video);
      tabs.set(tabId, {
        playing: !!msg.playing,
        videoPage: !!msg.videoPage,
        visible: !!msg.visible,
        focused: !!msg.focused,
        video,
        fp: seen.fp,
        category: seen.category,
        from: seen.from,
      });
      // A category that changed under the tab's feet is a segment boundary like
      // any other: the time before it was a different kind of time.
      await tick(Date.now(), { boundary: !!prev && prev.category !== seen.category });
      postLimit(port, tabId);
    } else if (msg.type === 'hello') {
      if (tabId != null && !tabs.has(tabId)) {
        const seen = await recall(tabId, null);
        tabs.set(tabId, {
          playing: false, videoPage: false, visible: false, focused: false,
          video: null, fp: seen.fp, category: seen.category, from: seen.from,
        });
      }
      postLimit(port, tabId);
      port.postMessage({ type: 'snapshot', ...(await snapshot()) });
    } else if (msg.type === 'subscribe') {
      port.postMessage({ type: 'snapshot', ...(await snapshot()) });
    }
  });

  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (tabId != null) {
      tabs.delete(tabId);
      chrome.storage.session.remove(`cat:${tabId}`).catch(() => {});
      tick();
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ready;
    if (!msg || typeof msg !== 'object') return sendResponse(null);
    switch (msg.type) {
      case 'getSnapshot':
        await tick();
        return sendResponse(await snapshot());
      case 'setCategory': {
        const tabId = msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id);
        if (tabId == null) return sendResponse(null);
        const t = tabs.get(tabId);
        const fp = t ? t.fp : null;
        await chrome.storage.session.set({ [`cat:${tabId}`]: { c: msg.category, fp } });
        // Said about a video, and so remembered against it. `unset` is you taking
        // the judgement back, which forgets it rather than recording an opinion.
        if (fp && (settings.rememberMarks || msg.category === 'unset')) {
          marks = await saveMarks(msg.category === 'unset'
            ? forgetMark(marks, fp)
            : putMark(marks, fp, msg.category));
        }
        if (t) { t.category = msg.category; t.from = 'you'; }
        await tick(Date.now(), { boundary: true });
        broadcastLimit();
        return sendResponse(await snapshot());
      }
      case 'settingsChanged': {
        settings = await getSettings();
        if (!settings.rememberMarks) dropRecalled();
        chrome.idle.setDetectionInterval(Math.max(15, settings.idleSeconds));
        lastRemindBucket = null;
        await closeOpen();
        todayKey = dayKey(Date.now(), settings.dayStartHour);
        storedToday = totals(await getDay(todayKey));
        await refreshEconomy();
        await refreshBadge();
        broadcastLimit();
        return sendResponse(await snapshot());
      }
      case 'forgetMarks': {
        marks = {};
        await clearMarks();
        dropRecalled();
        await tick(Date.now(), { boundary: true });
        broadcastLimit();
        return sendResponse(await snapshot());
      }
      case 'openDashboard':
        await chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard.html') });
        return sendResponse(true);
      case 'dataChanged':
        // The dashboard just rewrote this day. Storage is now the truth, so throw
        // away the in-flight segment rather than flushing it back over the edit.
        discardOpen();
        lastRemindBucket = null;
        storedToday = totals(await getDay(todayKey));
        await refreshEconomy();
        await refreshBadge();
        broadcastLimit();
        return sendResponse(await snapshot());
      default:
        return sendResponse(null);
    }
  })();
  return true; // async sendResponse
});

/**
 * Tabs riding a remembered mark lose it now, not at the next video: remembering
 * has just been switched off or the marks thrown away, and a tab still counting
 * as educational because of a mark that no longer exists would be lying about why.
 */
function dropRecalled() {
  for (const t of tabs.values()) {
    if (t.from === 'memory') { t.category = settings.defaultCategory; t.from = 'default'; }
  }
}

/** What you last said about this tab, and the video you said it about. */
async function tabSaid(tabId) {
  const got = await chrome.storage.session.get(`cat:${tabId}`);
  const stored = got[`cat:${tabId}`];
  if (stored && typeof stored === 'object' && stored.c) return stored;
  // A plain string is what 0.6.x wrote: a tab marked before this build was
  // installed keeps its mark instead of quietly falling back to the default.
  if (typeof stored === 'string') return { c: stored, fp: null };
  return null;
}

/**
 * The category a tab should carry on this video, in order of how much it was meant:
 *
 *   1. what you said about this tab while it was on this very video
 *   2. what you once said about this video, in any tab, on any day
 *   3. what you said about this tab on some other video (a tab stays as you set it)
 *   4. the default for new tabs
 *
 * `from` travels with it so the indicator can admit which of those happened —
 * a tab that turns educational on its own has to say why.
 */
async function recall(tabId, video) {
  const fp = video ? await fingerprint(video) : null;
  const said = await tabSaid(tabId);
  if (said && fp && said.fp === fp) return { category: said.c, from: 'you', fp };
  const remembered = fp && settings.rememberMarks ? lookupMark(marks, fp) : null;
  if (remembered) {
    // Seeing it again is what keeps it: the prune measures last seen, not last said.
    marks = await saveMarks(touchMark(marks, fp));
    return { category: remembered, from: 'memory', fp };
  }
  if (said) return { category: said.c, from: 'you', fp };
  return { category: settings.defaultCategory, from: 'default', fp };
}

// ------------------------------------------------------------- the decision

function evaluate() {
  return decide([...tabs.values()], {
    idleState,
    countBackground: settings.countBackground,
    defaultCategory: settings.defaultCategory,
  });
}

// ------------------------------------------------------------- the ledger

async function tick(now = Date.now(), { boundary = false } = {}) {
  if (ticking) return;
  ticking = true;
  try {
    const next = evaluate();
    const elapsed = now - anchor;

    if (open) {
      if (elapsed > MAX_GAP_MS) {
        // The machine slept or the worker was frozen. Bill nothing for the gap.
        await closeOpen();
      } else if (elapsed > 0) {
        open.e = now;
      }
    }

    const sameKind = open && next && open.c === next.c && open.bg === next.bg;
    if (open && (!next || !sameKind || boundary)) await closeOpen();

    if (next && !open) {
      open = { id: newId(now), s: now, e: now, c: next.c, bg: next.bg, flushedTo: now };
    }

    anchor = now;

    if (dayKey(now, settings.dayStartHour) !== todayKey) {
      await flush(true);
      todayKey = dayKey(now, settings.dayStartHour);
      storedToday = totals(await getDay(todayKey));
      await refreshEconomy(); // yesterday just closed: settle up before counting on
    } else if (open && now - lastFlush >= FLUSH_MS) {
      await flush();
    }

    await refreshBadge();
    updateReminder();
  } finally {
    ticking = false;
  }
}

/** Write the open segment (splitting it across the 04:00 boundary if needed). */
async function flush() {
  if (!open || open.e <= open.s) return;
  const parts = splitByDay({ id: open.id, s: open.s, e: open.e, c: open.c, bg: open.bg }, settings.dayStartHour);
  for (let i = 0; i < parts.length; i += 1) {
    const { key, seg } = parts[i];
    const stored = await upsertSegment(key, { ...seg, id: i === 0 ? open.id : `${open.id}_${i}` });
    if (key === todayKey) storedToday = totals(stored);
  }
  open.flushedTo = open.e;
  lastFlush = Date.now();
}

/** Forget the open segment without writing it (loses at most one flush window). */
function discardOpen() {
  open = null;
  anchor = Date.now();
}

async function closeOpen() {
  if (!open) return;
  await flush();
  open = null;
}

/** Today's entertainment total, including the part of the open segment not yet written. */
function entMsNow() {
  let ms = storedToday.ent;
  if (open && open.c === 'ent' && dayKey(open.e, settings.dayStartHour) === todayKey) {
    ms += Math.max(0, open.e - open.flushedTo);
  }
  return ms;
}

// -------------------------------------------------------------- the limit

async function refreshEconomy() {
  const chain = await refreshCarry(settings);
  carryToday = settings.carryEnabled ? carryOn(chain, todayKey) : NO_CARRY;
  // Today's ceiling just moved. That is not time being spent, so the reminder
  // steps are re-seated rather than announced — otherwise a day rolling over,
  // or an edit to last week, would nudge you about a video you are not watching.
  lastRemindBucket = null;
}

/** The limit as configured — the number in Settings, the same every day. */
function limitMs() {
  return Math.max(0, settings.entLimitMin) * 60000;
}

/** The limit as it applies today, once banked time is added. */
function allowanceMs() {
  return allowanceFor(carryToday, limitMs());
}

/** Entertainment charged to today: watched plus owed. */
function chargedMs() {
  return chargedFor(entMsNow(), carryToday);
}

function remainingMs() {
  return allowanceMs() - chargedMs();
}

async function refreshBadge() {
  const used = chargedMs();
  const left = remainingMs();
  const nowBlocked = settings.blockEnabled && left <= 0;
  if (nowBlocked !== blocked) {
    blocked = nowBlocked;
    broadcastLimit();
  }
  const mins = Math.max(0, Math.ceil(left / 60000));
  const text = left <= 0 ? '0' : (mins >= 100 ? `${Math.floor(mins / 60)}h` : String(mins));
  const color = left <= 0 ? '#96201c' : (left <= 10 * 60000 ? '#f7b731' : '#1a9b22');
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    const ceiling = fmtDuration(allowanceMs());
    await chrome.action.setTitle({
      title: `TubeLedger — ${fmtDuration(used)} of ${ceiling} entertainment used today`
        + (carryToday.debt ? ` (${fmtDuration(carryToday.debt)} carried over)` : '')
        + (carryToday.bonus ? ` (${fmtDuration(carryToday.bonus)} banked)` : ''),
    });
  } catch { /* action API unavailable during teardown */ }
}

function limitMessage() {
  const left = remainingMs();
  return {
    type: 'limit',
    blocked: settings.blockEnabled && left <= 0,
    usedMs: chargedMs(),
    limitMs: allowanceMs(),
    baseLimitMs: limitMs(),
    remainingMs: left,
    debtMs: carryToday.debt,
    bonusMs: carryToday.bonus,
    restriction: restrictionFor(left),
    blockEnabled: settings.blockEnabled,
    hudEnabled: settings.hudEnabled,
    build: chrome.runtime.getManifest().version,
  };
}

/**
 * Nudge the watcher every `remindEveryMin` of budget spent. The step is worked
 * out here, once, rather than in each tab: the worker is the only thing that
 * knows the running total. Tabs decide whether they are the one being watched.
 */
function updateReminder() {
  const interval = Math.max(0, settings.remindEveryMin) * 60000;
  if (!interval || !settings.hudEnabled) {
    lastRemindBucket = null;
    return;
  }
  const remaining = Math.max(0, remainingMs());
  const bucket = remindBucket(remaining, interval);
  if (lastRemindBucket === null || bucket > lastRemindBucket) {
    // First look, a new day, or time edited back in: take the step, say nothing.
    lastRemindBucket = bucket;
    return;
  }
  if (bucket < lastRemindBucket) {
    lastRemindBucket = bucket;
    if (remaining > 0) broadcastRemind(bucket * interval);
  }
}

function broadcastRemind(remainingMs) {
  for (const port of ports.keys()) {
    try { port.postMessage({ type: 'remind', remainingMs }); } catch { /* port closed */ }
  }
}

function postLimit(port, tabId) {
  const tab = tabId != null ? tabs.get(tabId) : null;
  const msg = {
    ...limitMessage(),
    category: tab ? tab.category : null,
    categoryFrom: tab ? tab.from : null,
  };
  try { port.postMessage(msg); } catch { /* port closed */ }
}

function broadcastLimit() {
  for (const [port, tabId] of ports) postLimit(port, tabId);
}

async function snapshot() {
  const current = open ? { c: open.c, bg: open.bg, since: open.s } : null;
  const live = { ...storedToday, byKind: { ...storedToday.byKind } };
  if (open) {
    const pending = Math.max(0, open.e - open.flushedTo);
    live[open.c] += pending;
    live.total += pending;
    if (open.bg) live.bg += pending; else live.fg += pending;
    live.byKind[`${open.c}_${open.bg ? 'bg' : 'fg'}`] += pending;
  }
  return {
    dayKey: todayKey,
    totals: live,
    current,
    idleState,
    settings,
    limitMs: allowanceMs(),
    baseLimitMs: limitMs(),
    carry: carryToday,
    blocked: settings.blockEnabled && remainingMs() <= 0,
    tabCategories: Object.fromEntries([...tabs].map(([id, t]) => [id, t.category])),
    tabCategoryFrom: Object.fromEntries([...tabs].map(([id, t]) => [id, t.from])),
    markCount: countMarks(marks),
  };
}

// Keep the worker honest if it is woken without any port traffic.
setInterval(() => { tick(); }, HEARTBEAT_MS * 2);
