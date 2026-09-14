// Drives the real service worker against a stubbed chrome.* and a fake clock,
// to prove the ledger that ends up in storage matches what the tabs did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { totals } from '../src/lib/model.js';

let now = new Date(2026, 8, 12, 10, 0, 0, 0).getTime(); // 10:00 local
const realNow = Date.now;
Date.now = () => now;
globalThis.setInterval = () => 0; // the worker's keepalive would hang the test run

const store = {};
const session = {};
const listeners = { connect: [], message: [], alarm: [] };
let badge = '';

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return { ...store };
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (k in store) out[k] = store[k];
        return out;
      },
      async set(obj) { Object.assign(store, obj); },
      async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
      async clear() { for (const k of Object.keys(store)) delete store[k]; },
    },
    session: {
      async get(k) { return k in session ? { [k]: session[k] } : {}; },
      async set(obj) { Object.assign(session, obj); },
      async remove(k) { delete session[k]; },
    },
  },
  alarms: { create() {}, onAlarm: { addListener: (fn) => listeners.alarm.push(fn) } },
  idle: {
    setDetectionInterval() {},
    queryState: (_s, cb) => cb('active'),
    onStateChanged: { addListener() {} },
  },
  action: {
    async setBadgeText({ text }) { badge = text; },
    async setBadgeBackgroundColor() {},
    async setTitle() {},
  },
  tabs: { async create() {} },
  runtime: {
    getURL: (p) => p,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onConnect: { addListener: (fn) => listeners.connect.push(fn) },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
  },
};

await import('../src/background.js');
const connect = listeners.connect[0];

/** Let the worker's fire-and-forget async work finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A content script in tab `id`. */
function openTab(id) {
  const handlers = { message: [], disconnect: [] };
  const inbox = [];
  const port = {
    sender: { tab: { id } },
    postMessage(msg) { inbox.push(msg); },
    onMessage: { addListener: (fn) => handlers.message.push(fn) },
    onDisconnect: { addListener: (fn) => handlers.disconnect.push(fn) },
  };
  connect(port);
  return {
    inbox,
    reminders: () => inbox.filter((m) => m && m.type === 'remind').map((m) => m.remainingMs),
    async say(msg) { for (const fn of handlers.message) await fn(msg); },
    async close() {
      for (const fn of handlers.disconnect) await fn();
      await settle(); // the worker flushes the open session off the disconnect
    },
  };
}

function ask(msg) {
  return new Promise((resolve) => {
    listeners.message[0](msg, {}, resolve);
  });
}

/** Flip a tab into a new state at the current instant. */
async function switchTo(tab, state) {
  await tab.say({ type: 'state', ...state });
}

/** Hold a state for `seconds`, pinging every 5s the way a content script does. */
async function hold(tab, seconds, state) {
  for (let left = seconds; left > 0; left -= 5) {
    now += Math.min(5, left) * 1000;
    await tab.say({ type: 'state', ...state });
  }
}

const WATCHING = { playing: true, videoPage: true, visible: true, focused: true };
const BROWSING = { playing: false, videoPage: false, visible: true, focused: true };
const HIDDEN_PLAYING = { playing: true, videoPage: true, visible: false, focused: false };
const HIDDEN_IDLE = { playing: false, videoPage: false, visible: false, focused: false };

const dayOf = () => totals(store['d:2026-09-12'] || []);

test('a watched, then backgrounded, then abandoned session lands in the ledger', async () => {
  const tab = openTab(1);
  await tab.say({ type: 'hello' });

  await switchTo(tab, BROWSING);
  await hold(tab, 60, BROWSING);           // 1m of menus
  await switchTo(tab, WATCHING);
  await hold(tab, 600, WATCHING);          // 10m of entertainment
  await switchTo(tab, HIDDEN_PLAYING);
  await hold(tab, 300, HIDDEN_PLAYING);    // 5m still audible behind another window
  await switchTo(tab, HIDDEN_IDLE);
  await hold(tab, 180, HIDDEN_IDLE);       // 3m hidden and paused: not counted at all

  const t = dayOf();
  assert.equal(t.menu, 60000, 'menu time');
  assert.equal(t.byKind.ent_fg, 600000, 'foreground entertainment');
  assert.equal(t.byKind.ent_bg, 300000, 'background entertainment');
  assert.equal(t.total, 960000, 'nothing counted while hidden and paused');
});

test('the ledger never bills more than the wall clock, with two tabs playing', async () => {
  const before = dayOf().total;
  const a = openTab(2);
  const b = openTab(3);
  await a.say({ type: 'hello' });
  await b.say({ type: 'hello' });
  await switchTo(a, HIDDEN_PLAYING);
  await switchTo(b, HIDDEN_PLAYING);

  for (let i = 0; i < 60; i += 1) { // five minutes of two tabs both making noise
    now += 5000;
    await a.say({ type: 'state', ...HIDDEN_PLAYING });
    await b.say({ type: 'state', ...HIDDEN_PLAYING });
  }

  await a.close();
  await b.close(); // closing flushes the tail of the open session
  assert.equal(dayOf().total - before, 300000);
});

test('a sleeping machine is not billed for the gap', async () => {
  const tab = openTab(4);
  await tab.say({ type: 'hello' });
  await switchTo(tab, WATCHING);
  await hold(tab, 30, WATCHING);
  const before = dayOf().total;

  now += 4 * 3600000; // laptop lid closed for four hours
  await tab.say({ type: 'state', ...WATCHING });
  await hold(tab, 30, WATCHING);

  const added = dayOf().total - before;
  assert.ok(added <= 35000, `the four-hour gap is not billed, got ${added}ms`);
  await tab.close();
});

test('re-categorising a tab splits the session instead of rewriting history', async () => {
  const tab = openTab(5);
  await tab.say({ type: 'hello' });
  await switchTo(tab, WATCHING);                  // starts as entertainment (the default)
  await hold(tab, 120, WATCHING);
  const entBefore = dayOf().ent;

  await ask({ type: 'setCategory', tabId: 5, category: 'work' });
  await hold(tab, 180, WATCHING);

  const t = dayOf();
  assert.equal(t.ent, entBefore, 'the entertainment already spent stays spent');
  assert.equal(t.work, 180000, 'the rest books as work');
  await tab.close();
});

test('the badge counts the entertainment budget down', async () => {
  const spent = dayOf().ent;
  const left = Math.max(0, 60 * 60000 - spent);
  assert.equal(badge, String(Math.ceil(left / 60000)));
});

test('crossing 04:00 files the two halves under different days', async () => {
  const entBefore = totals(store['d:2026-09-12'] || []).ent;
  now = new Date(2026, 8, 13, 3, 58, 0, 0).getTime();
  const tab = openTab(6);
  await tab.say({ type: 'hello' });
  await switchTo(tab, WATCHING);
  await hold(tab, 8 * 60, WATCHING); // 03:58 -> 04:06
  await tab.close();

  const yesterday = totals(store['d:2026-09-12'] || []).ent - entBefore;
  const today = totals(store['d:2026-09-13'] || []).ent;
  assert.equal(yesterday, 2 * 60000, 'two minutes filed before the boundary');
  assert.equal(today, 6 * 60000, 'six minutes filed after it');
});

test('watching entertainment is nudged at each round figure of budget left', async () => {
  now = new Date(2026, 8, 16, 12, 0, 0, 0).getTime(); // a fresh, empty day
  const tab = openTab(7);
  await tab.say({ type: 'hello' });
  await switchTo(tab, WATCHING);          // entertainment by default, 60m of budget

  await hold(tab, 4 * 60, WATCHING);
  assert.deepEqual(tab.reminders(), [], 'nothing said in the first four minutes');

  await hold(tab, 60, WATCHING);          // 5m spent: 55m left
  assert.deepEqual(tab.reminders(), [55 * 60000], 'one nudge, on the round figure');

  await hold(tab, 5 * 60, WATCHING);      // 10m spent
  await hold(tab, 5 * 60, WATCHING);      // 15m spent
  assert.deepEqual(tab.reminders(), [55 * 60000, 50 * 60000, 45 * 60000]);
  await tab.close();
});

test('work & education time is never nudged and never blocked', async () => {
  now = new Date(2026, 8, 17, 12, 0, 0, 0).getTime();
  const tab = openTab(8);
  await tab.say({ type: 'hello' });
  await ask({ type: 'setCategory', tabId: 8, category: 'work' });
  await switchTo(tab, WATCHING);
  await hold(tab, 40 * 60, WATCHING); // well past the 60m entertainment budget in length

  await tab.close(); // flushes the tail of the session
  assert.deepEqual(tab.reminders(), [], 'no nudges for educational viewing');
  assert.equal(tab.inbox.filter((m) => m.type === 'limit' && m.blocked).length, 0, 'never blocked');
  assert.equal(totals(store['d:2026-09-17'] || []).work, 40 * 60000);
});

test.after(() => { Date.now = realNow; });
