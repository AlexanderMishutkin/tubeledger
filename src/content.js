// Runs on youtube.com. Two jobs:
//   1. report what this tab is doing (playing? visible? focused?) to the worker
//   2. pause entertainment playback once the daily limit is spent
//
// It reads no video titles, no channel names, no URLs beyond the path shape.
// Built with createElement/textContent only — no innerHTML, no eval.
(() => {
  'use strict';

  const POLL_MS = 2000;
  const HEARTBEAT_MS = 10000;
  const OVERLAY_ID = 'tubeledger-limit-overlay';

  let port = null;
  let lastSignature = '';
  let lastSent = 0;
  let blocked = false;
  let category = null;
  let usedMs = 0;
  let limitMs = 0;
  let reconnectDelay = 1000;

  // ------------------------------------------------------------- detection

  function isVideoPage() {
    return /^\/(watch|shorts|live)/.test(location.pathname);
  }

  /**
   * True when something is really being watched.
   * Muted playback off a video page is YouTube's hover preview / autoplaying
   * thumbnail — that is browsing, not watching, so it does not count.
   */
  function isPlaying() {
    const onVideoPage = isVideoPage();
    for (const v of document.querySelectorAll('video, audio')) {
      const live = !v.paused && !v.ended && v.readyState >= 2;
      if (!live) continue;
      const audible = !v.muted && v.volume > 0;
      if (audible || onVideoPage) return true;
    }
    return false;
  }

  function collect() {
    return {
      type: 'state',
      playing: isPlaying(),
      videoPage: isVideoPage(),
      visible: document.visibilityState === 'visible',
      focused: document.hasFocus(),
    };
  }

  function send(force) {
    if (!port) return;
    const state = collect();
    const signature = `${state.playing}|${state.videoPage}|${state.visible}|${state.focused}`;
    const now = Date.now();
    if (!force && signature === lastSignature && now - lastSent < HEARTBEAT_MS) return;
    lastSignature = signature;
    lastSent = now;
    try {
      port.postMessage(state);
    } catch {
      port = null;
      scheduleReconnect();
    }
  }

  // ------------------------------------------------------------ connection

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'tab' });
    } catch {
      scheduleReconnect();
      return;
    }
    reconnectDelay = 1000;
    port.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'limit') return;
      blocked = !!msg.blocked;
      category = msg.category;
      usedMs = msg.usedMs || 0;
      limitMs = msg.limitMs || 0;
      enforce();
    });
    port.onDisconnect.addListener(() => {
      port = null;
      scheduleReconnect();
    });
    try {
      port.postMessage({ type: 'hello' });
    } catch { /* raced with a worker restart; the reconnect covers it */ }
    send(true);
  }

  function scheduleReconnect() {
    setTimeout(() => {
      if (!port) connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(30000, reconnectDelay * 2);
  }

  // ------------------------------------------------------------ the block

  function shouldBlock() {
    return blocked && category === 'ent';
  }

  function enforce() {
    if (!shouldBlock()) {
      removeOverlay();
      return;
    }
    for (const v of document.querySelectorAll('video, audio')) {
      if (!v.paused) v.pause();
    }
    showOverlay();
  }

  function fmt(ms) {
    const mins = Math.round(ms / 60000);
    if (mins >= 60) return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
    return `${mins}m`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function showOverlay() {
    let root = document.getElementById(OVERLAY_ID);
    if (root) {
      const line = root.querySelector('.tl-sub');
      if (line) line.textContent = `${fmt(usedMs)} of your ${fmt(limitMs)} daily entertainment budget is spent.`;
      return;
    }

    const style = el('style');
    style.textContent = `
      #${OVERLAY_ID} {
        position: fixed; inset: 0; z-index: 2147483647;
        display: flex; align-items: center; justify-content: center;
        background: rgba(12, 12, 11, 0.86);
        font: 14px/1.5 "Roboto", system-ui, -apple-system, sans-serif;
        color: #fcfcfb; padding: 24px;
      }
      #${OVERLAY_ID} .tl-card {
        max-width: 460px; width: 100%; background: #1a1a19;
        border: 1px solid #3a3a37; border-radius: 14px; padding: 28px;
        box-shadow: 0 20px 60px rgba(0,0,0,.5); text-align: left;
      }
      #${OVERLAY_ID} .tl-tag {
        display: inline-block; font-size: 11px; letter-spacing: .08em;
        text-transform: uppercase; color: #1a1a19; background: #ec7268;
        border-radius: 999px; padding: 3px 10px; font-weight: 600;
      }
      #${OVERLAY_ID} h2 { font-size: 22px; margin: 14px 0 6px; font-weight: 600; color: #fcfcfb; }
      #${OVERLAY_ID} .tl-sub { color: #c3c2b7; margin: 0 0 20px; }
      #${OVERLAY_ID} .tl-row { display: flex; gap: 10px; flex-wrap: wrap; }
      #${OVERLAY_ID} button {
        font: inherit; font-weight: 500; cursor: pointer; border-radius: 8px;
        padding: 9px 14px; border: 1px solid #4a4a46; background: transparent; color: #fcfcfb;
      }
      #${OVERLAY_ID} button.tl-primary { background: #1a9b22; border-color: #1a9b22; color: #fff; }
      #${OVERLAY_ID} button:hover { filter: brightness(1.12); }
      #${OVERLAY_ID} .tl-note { color: #8a8a85; font-size: 12px; margin: 18px 0 0; }
    `;

    root = el('div');
    root.id = OVERLAY_ID;
    const card = el('div', 'tl-card');
    card.appendChild(el('span', 'tl-tag', 'TubeLedger'));
    card.appendChild(el('h2', null, 'Daily entertainment limit reached'));
    card.appendChild(el('p', 'tl-sub', `${fmt(usedMs)} of your ${fmt(limitMs)} daily entertainment budget is spent.`));

    const row = el('div', 'tl-row');
    const workBtn = el('button', 'tl-primary', 'This is work & education');
    workBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'setCategory', category: 'work' }, () => {
        category = 'work';
        removeOverlay();
      });
    });
    const dashBtn = el('button', null, 'Open dashboard');
    dashBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'openDashboard' });
    });
    row.appendChild(workBtn);
    row.appendChild(dashBtn);
    card.appendChild(row);
    card.appendChild(el('p', 'tl-note', 'The budget resets at the start of your next day. Raise it in the dashboard if you mean to.'));

    root.appendChild(style);
    root.appendChild(card);
    (document.body || document.documentElement).appendChild(root);
  }

  function removeOverlay() {
    const root = document.getElementById(OVERLAY_ID);
    if (root) root.remove();
  }

  // ---------------------------------------------------------------- wiring

  for (const evt of ['visibilitychange', 'focus', 'blur', 'pageshow']) {
    window.addEventListener(evt, () => send(true), true);
  }
  document.addEventListener('visibilitychange', () => send(true), true);
  // Media events do not bubble; capture them at the document instead.
  for (const evt of ['play', 'pause', 'ended', 'emptied', 'volumechange']) {
    document.addEventListener(evt, () => {
      send(true);
      if (evt === 'play') enforce();
    }, true);
  }
  window.addEventListener('yt-navigate-finish', () => send(true), true);
  window.addEventListener('pagehide', () => {
    if (port) {
      try { port.disconnect(); } catch { /* already gone */ }
      port = null;
    }
  });

  setInterval(() => {
    send(false);
    if (shouldBlock()) enforce();
  }, POLL_MS);

  connect();
})();
