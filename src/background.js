// Service worker: the accounting engine.
//
// Content scripts report what their tab is doing; this worker decides which
// single class of time is running right now, accrues it into one open segment,
// and flushes that segment to storage. Only one class can run at a time, so the
// ledger can never add up to more than wall-clock time.
import {
  DEFAULT_SETTINGS, dayKey, splitByDay, totals, emptyTotals, fmtDuration, remindBucket,
} from './lib/model.js';
import {
  getSettings, getDay, upsertSegment, newId,
} from './lib/store.js';
import { decide } from './lib/decide.js';

const HEARTBEAT_MS = 5000;   // content scripts ping at this rate
const MAX_GAP_MS = 20000;    // a bigger jump means sleep/suspend: don't bill it
const FLUSH_MS = 15000;      // worst-case data loss if the browser dies

/** @type {Map<number, {playing:boolean, videoPage:boolean, visible:boolean, focused:boolean, category:string}>} */
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

// ---------------------------------------------------------------- lifecycle

async function init() {
  settings = await getSettings();
  chrome.idle.setDetectionInterval(Math.max(15, settings.idleSeconds));
  idleState = await new Promise((r) => chrome.idle.queryState(Math.max(15, settings.idleSeconds), r));
  todayKey = dayKey(Date.now(), settings.dayStartHour);
  storedToday = totals(await getDay(todayKey));
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
      tabs.set(tabId, {
        playing: !!msg.playing,
        videoPage: !!msg.videoPage,
        visible: !!msg.visible,
        focused: !!msg.focused,
        category: (prev && prev.category) || await tabCategory(tabId),
      });
      await tick();
      postLimit(port, tabId);
    } else if (msg.type === 'hello') {
      if (tabId != null && !tabs.has(tabId)) {
        tabs.set(tabId, {
          playing: false, videoPage: false, visible: false, focused: false,
          category: await tabCategory(tabId),
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
        await chrome.storage.session.set({ [`cat:${tabId}`]: msg.category });
        const t = tabs.get(tabId);
        if (t) t.category = msg.category;
        await tick(Date.now(), { boundary: true });
        broadcastLimit();
        return sendResponse(await snapshot());
      }
      case 'settingsChanged':
        settings = await getSettings();
        chrome.idle.setDetectionInterval(Math.max(15, settings.idleSeconds));
        lastRemindBucket = null;
        await closeOpen();
        todayKey = dayKey(Date.now(), settings.dayStartHour);
        storedToday = totals(await getDay(todayKey));
        await refreshBadge();
        broadcastLimit();
        return sendResponse(await snapshot());
      case 'openDashboard':
        await chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard.html') });
        return sendResponse(true);
      case 'dataChanged':
        // The dashboard just rewrote this day. Storage is now the truth, so throw
        // away the in-flight segment rather than flushing it back over the edit.
        discardOpen();
        lastRemindBucket = null;
        storedToday = totals(await getDay(todayKey));
        await refreshBadge();
        broadcastLimit();
        return sendResponse(await snapshot());
      default:
        return sendResponse(null);
    }
  })();
  return true; // async sendResponse
});

async function tabCategory(tabId) {
  const got = await chrome.storage.session.get(`cat:${tabId}`);
  const stored = got[`cat:${tabId}`];
  if (stored === 'work' || stored === 'ent' || stored === 'unset') return stored;
  return settings.defaultCategory;
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

function limitMs() {
  return Math.max(0, settings.entLimitMin) * 60000;
}

async function refreshBadge() {
  const used = entMsNow();
  const left = limitMs() - used;
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
    await chrome.action.setTitle({
      title: `TubeLedger — ${fmtDuration(used)} of ${settings.entLimitMin}m entertainment used today`,
    });
  } catch { /* action API unavailable during teardown */ }
}

function limitMessage() {
  return {
    type: 'limit',
    blocked: settings.blockEnabled && entMsNow() >= limitMs(),
    usedMs: entMsNow(),
    limitMs: limitMs(),
    blockEnabled: settings.blockEnabled,
    hudEnabled: settings.hudEnabled,
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
  const remaining = Math.max(0, limitMs() - entMsNow());
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
  const msg = { ...limitMessage(), category: tab ? tab.category : null };
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
    limitMs: limitMs(),
    blocked: settings.blockEnabled && entMsNow() >= limitMs(),
    tabCategories: Object.fromEntries([...tabs].map(([id, t]) => [id, t.category])),
  };
}

// Keep the worker honest if it is woken without any port traffic.
setInterval(() => { tick(); }, HEARTBEAT_MS * 2);
