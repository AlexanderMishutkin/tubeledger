// Writing the ledger to a real file, quietly.
//
// The first attempt at this used chrome.downloads, which works but pops the
// download bubble every time — unacceptable for something that runs on its own.
// The File System Access API writes straight into a folder you pick once, with
// no UI at all. The cost is that it only works from an extension page (the popup
// or the dashboard), never from the service worker, so backups happen when one
// of those is open rather than on a timer. In practice the popup is opened most
// days, and nothing is lost in the meantime: chrome.storage.local is still the
// live store, and this is the copy that survives losing it.
import { backupFilenames, needsBackup } from './model.js';
import { exportAll, getBackupMeta, setBackupMeta } from './store.js';

const DB_NAME = 'tubeledger';
const STORE = 'handles';
const HANDLE_KEY = 'backupDir';

/** IndexedDB can hang (blocked, private mode, a broken profile). Never wait forever. */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

/** The folder handle survives browser restarts; the permission on it may not. */
export async function storedFolder() {
  try {
    return (await withTimeout(idb('readonly', (store) => store.get(HANDLE_KEY)), 1500, null)) || null;
  } catch {
    return null;
  }
}

export function supported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** Needs a user gesture — call it straight from a click handler. */
export async function chooseFolder() {
  const handle = await window.showDirectoryPicker({
    id: 'tubeledger-backup',
    mode: 'readwrite',
    startIn: 'documents',
  });
  await idb('readwrite', (store) => store.put(handle, HANDLE_KEY));
  return handle;
}

export async function forgetFolder() {
  await idb('readwrite', (store) => store.delete(HANDLE_KEY));
}

/** 'none' | 'granted' | 'prompt' | 'denied' — 'prompt' needs one click to revive. */
export async function folderState(handle) {
  if (!handle) return 'none';
  try {
    return await withTimeout(handle.queryPermission({ mode: 'readwrite' }), 1500, 'prompt');
  } catch {
    return 'denied';
  }
}

/** Ask for permission again. Needs a user gesture, so only from a click. */
export async function reconnect(handle) {
  try {
    return await handle.requestPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

/**
 * Write the backup if one is due (or if forced). Returns the new meta.
 * Silent by design: no picker, no prompt, no download — if it cannot write, it
 * records why so the dashboard can say so out loud.
 */
export async function backupIfDue(todayKey, { force = false } = {}) {
  const meta = await getBackupMeta();
  if (!force && !needsBackup(meta, todayKey)) return meta;

  const handle = await storedFolder();
  if (!handle) return meta; // nothing chosen yet: not a failure, just not set up

  const state = await folderState(handle);
  if (state !== 'granted') {
    return setBackupMeta({ ...meta, error: 'folder needs reconnecting', needsReconnect: true });
  }

  try {
    const payload = await exportAll();
    const json = JSON.stringify(payload);
    const files = backupFilenames(todayKey);
    for (const name of files) {
      const fileHandle = await handle.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(json);
      await writable.close();
    }
    return setBackupMeta({
      lastDay: todayKey,
      lastAt: Date.now(),
      folder: handle.name,
      files,
      bytes: json.length,
      error: null,
      needsReconnect: false,
    });
  } catch (e) {
    return setBackupMeta({ ...meta, error: String((e && e.message) || e), lastAttemptAt: Date.now() });
  }
}
