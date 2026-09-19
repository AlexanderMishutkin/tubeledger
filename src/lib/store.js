// Thin wrapper over chrome.storage.local. Days live under `d:YYYY-MM-DD`,
// settings under `settings`. Nothing ever leaves the browser.
import {
  DEFAULT_SETTINGS, mergeAdjacent, normalize, totals, carryChain, dayKey, NO_CARRY,
} from './model.js';

const DAY_PREFIX = 'd:';
export const SETTINGS_KEY = 'settings';

export function dayStorageKey(key) {
  return DAY_PREFIX + key;
}

export async function getSettings() {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getDay(key) {
  const got = await chrome.storage.local.get(dayStorageKey(key));
  return normalize(got[dayStorageKey(key)] || []);
}

export async function getDays(keys) {
  if (!keys.length) return {};
  const got = await chrome.storage.local.get(keys.map(dayStorageKey));
  const out = {};
  for (const key of keys) out[key] = normalize(got[dayStorageKey(key)] || []);
  return out;
}

export async function setDay(key, segments) {
  const clean = mergeAdjacent(segments);
  if (clean.length) await chrome.storage.local.set({ [dayStorageKey(key)]: clean });
  else await chrome.storage.local.remove(dayStorageKey(key));
  return clean;
}

/** Replace the segment with the same id, or append it. */
export async function upsertSegment(key, seg) {
  const segments = await getDay(key);
  const i = segments.findIndex((s) => s.id === seg.id);
  if (i >= 0) segments[i] = { ...segments[i], ...seg };
  else segments.push(seg);
  return setDay(key, segments);
}

export async function listDayKeys() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all)
    .filter((k) => k.startsWith(DAY_PREFIX))
    .map((k) => k.slice(DAY_PREFIX.length))
    .sort();
}

export async function exportAll() {
  const all = await chrome.storage.local.get(null);
  // Settings are written out even when they have never been changed, so a restored
  // file brings back the same setup rather than silently falling back to defaults.
  return {
    format: 'tubeledger/1',
    exported: new Date().toISOString(),
    data: { ...all, settings: await getSettings() },
  };
}

export async function importAll(payload, { replace = false } = {}) {
  if (!payload || payload.format !== 'tubeledger/1' || typeof payload.data !== 'object') {
    throw new Error('Not a TubeLedger export.');
  }
  if (replace) await chrome.storage.local.clear();
  await chrome.storage.local.set(payload.data);
}

const CARRY_KEY = 'carry';

/** Entertainment per day, for every day on record. */
export async function entByDay() {
  const all = await chrome.storage.local.get(null);
  const out = {};
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(DAY_PREFIX)) continue;
    out[key.slice(DAY_PREFIX.length)] = totals(normalize(value || [])).ent;
  }
  return out;
}

/**
 * Re-derive the whole debt/bonus chain from the entries themselves and store it.
 * Cheap — a year of days is 365 additions — and being derived rather than
 * accumulated means an edit to any past day corrects every day that follows.
 */
export async function refreshCarry(settings) {
  const limitMs = Math.max(0, settings.entLimitMin) * 60000;
  const today = dayKey(Date.now(), settings.dayStartHour);
  const chain = settings.carryEnabled
    ? carryChain(await entByDay(), today, limitMs, settings.carryShare)
    : {};
  await chrome.storage.local.set({ [CARRY_KEY]: chain });
  return chain;
}

export async function getCarryChain() {
  const got = await chrome.storage.local.get(CARRY_KEY);
  return got[CARRY_KEY] || {};
}

export function carryOn(chain, key) {
  return (chain && chain[key]) || NO_CARRY;
}

const MARKS_KEY = 'marks';

/** Fingerprint -> { c, t }: the categories you have already decided on. */
export async function getMarks() {
  const got = await chrome.storage.local.get(MARKS_KEY);
  return got[MARKS_KEY] || {};
}

export async function saveMarks(marks) {
  await chrome.storage.local.set({ [MARKS_KEY]: marks });
  return marks;
}

export async function clearMarks() {
  await chrome.storage.local.remove(MARKS_KEY);
}

const BACKUP_KEY = 'backup';

export async function getBackupMeta() {
  const got = await chrome.storage.local.get(BACKUP_KEY);
  return got[BACKUP_KEY] || {};
}

export async function setBackupMeta(meta) {
  await chrome.storage.local.set({ [BACKUP_KEY]: meta });
  return meta;
}

export function newId(startMs) {
  return `${startMs.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
