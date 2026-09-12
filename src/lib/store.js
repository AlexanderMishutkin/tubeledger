// Thin wrapper over chrome.storage.local. Days live under `d:YYYY-MM-DD`,
// settings under `settings`. Nothing ever leaves the browser.
import { DEFAULT_SETTINGS, mergeAdjacent, normalize } from './model.js';

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
  return { format: 'tubeledger/1', exported: new Date().toISOString(), data: all };
}

export async function importAll(payload, { replace = false } = {}) {
  if (!payload || payload.format !== 'tubeledger/1' || typeof payload.data !== 'object') {
    throw new Error('Not a TubeLedger export.');
  }
  if (replace) await chrome.storage.local.clear();
  await chrome.storage.local.set(payload.data);
}

export function newId(startMs) {
  return `${startMs.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
