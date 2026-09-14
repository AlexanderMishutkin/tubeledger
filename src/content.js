// Runs on youtube.com. Three jobs:
//   1. report what this tab is doing (playing? visible? focused?) to the worker
//   2. show the corner indicator: mode, budget left, and the periodic reminder
//   3. pause entertainment playback once the daily limit is spent
//
// It reads no video titles, no channel names, no URLs beyond the path shape.
// Built with createElement/textContent only — no innerHTML, no eval.
(() => {
  'use strict';

  const POLL_MS = 2000;
  const HEARTBEAT_MS = 10000;
  const OVERLAY_ID = 'tubeledger-limit-overlay';
  const HUD_ID = 'tubeledger-hud';
  const STYLE_ID = 'tubeledger-style';
  const TOAST_MS = 7000;
  const CHIP_SETTLE_MS = 6000;

  let port = null;
  let lastSignature = '';
  let lastSent = 0;
  let reconnectDelay = 1000;

  // Pushed by the worker; the content script never computes budget arithmetic.
  let blocked = false;
  let category = null;
  let usedMs = 0;
  let limitMs = 0;
  let hudEnabled = true;

  let hudSignature = '';
  let toastTimer = null;
  let settleTimer = null;

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
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'limit') {
        blocked = !!msg.blocked;
        category = msg.category;
        usedMs = msg.usedMs || 0;
        limitMs = msg.limitMs || 0;
        hudEnabled = msg.hudEnabled !== false;
        enforce();
        renderHud();
      } else if (msg.type === 'remind') {
        // The worker crossed a reminder step; show it only where it is being watched.
        if (hudEnabled && !blocked && category === 'ent' && isPlaying() && inFront()) {
          showToast(msg.remainingMs || 0);
        }
      }
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

  // --------------------------------------------------------------- helpers

  function inFront() {
    return document.visibilityState === 'visible' && document.hasFocus();
  }

  function fmt(ms) {
    const mins = Math.round(ms / 60000);
    if (mins >= 60) {
      const rest = mins % 60;
      return rest ? `${Math.floor(mins / 60)}h ${String(rest).padStart(2, '0')}m` : `${Math.floor(mins / 60)}h`;
    }
    return `${mins}m`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Fullscreen swallows the page, so anything on top has to live inside it. */
  function mountTarget() {
    return document.fullscreenElement || document.body || document.documentElement;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = el('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${HUD_ID} {
        position: fixed; top: 68px; right: 16px; z-index: 2147483000;
        display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
        font: 500 12px/1.4 "Roboto", system-ui, -apple-system, sans-serif;
        pointer-events: none;
      }
      #${HUD_ID}.tl-fs { top: 20px; right: 20px; }
      #${HUD_ID} .tl-pill {
        display: flex; align-items: center; gap: 8px; pointer-events: auto;
        background: rgba(22, 22, 21, .92); color: #fcfcfb;
        border: 1px solid rgba(255, 255, 255, .14); border-radius: 999px;
        padding: 6px 12px; box-shadow: 0 4px 16px rgba(0, 0, 0, .28);
        backdrop-filter: blur(6px); transition: opacity .4s ease;
        max-width: 320px;
      }
      #${HUD_ID} .tl-pill.tl-settled { opacity: .5; }
      #${HUD_ID} .tl-pill:hover { opacity: 1; }
      #${HUD_ID} .tl-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
      #${HUD_ID} .tl-check {
        width: 15px; height: 15px; border-radius: 50%; flex: none;
        display: flex; align-items: center; justify-content: center;
        background: #1a9b22; color: #fff; font-size: 10px; font-weight: 700;
      }
      #${HUD_ID} .tl-time { font-variant-numeric: tabular-nums; }
      #${HUD_ID} .tl-sep { color: rgba(255, 255, 255, .35); }
      #${HUD_ID} .tl-quiet { color: #c3c2b7; font-weight: 400; }
      #${HUD_ID} .tl-switch {
        pointer-events: auto; font: inherit; font-size: 11px; cursor: pointer;
        background: rgba(255, 255, 255, .10); color: #fcfcfb;
        border: 0; border-radius: 999px; padding: 3px 9px; margin-left: 2px;
      }
      #${HUD_ID} .tl-switch:hover { background: rgba(255, 255, 255, .2); }
      #${HUD_ID} .tl-toast {
        display: flex; align-items: center; gap: 9px; pointer-events: auto;
        background: rgba(22, 22, 21, .96); color: #fcfcfb;
        border: 1px solid rgba(255, 255, 255, .16); border-left: 3px solid #ec7268;
        border-radius: 10px; padding: 10px 14px; font-size: 13px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, .4);
        animation: tl-in .28s ease both;
      }
      #${HUD_ID} .tl-toast.tl-out { animation: tl-out .3s ease both; }
      #${HUD_ID} .tl-toast .tl-big { font-weight: 600; font-variant-numeric: tabular-nums; }
      @keyframes tl-in { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: none; } }
      @keyframes tl-out { to { opacity: 0; transform: translateX(12px); } }
      @media (prefers-reduced-motion: reduce) {
        #${HUD_ID} .tl-toast, #${HUD_ID} .tl-toast.tl-out { animation: none; }
      }

      #${OVERLAY_ID} {
        position: fixed; inset: 0; z-index: 2147483647;
        display: flex; align-items: center; justify-content: center;
        background: rgba(12, 12, 11, .86);
        font: 14px/1.5 "Roboto", system-ui, -apple-system, sans-serif;
        color: #fcfcfb; padding: 24px;
      }
      #${OVERLAY_ID} .tl-card {
        max-width: 460px; width: 100%; background: #1a1a19;
        border: 1px solid #3a3a37; border-radius: 14px; padding: 28px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, .5); text-align: left;
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
    (document.head || document.documentElement).appendChild(style);
  }

  // ------------------------------------------------------------- the corner

  function hudRoot() {
    let root = document.getElementById(HUD_ID);
    if (!root) {
      ensureStyles();
      root = el('div');
      root.id = HUD_ID;
      root.setAttribute('role', 'status');
      root.setAttribute('aria-live', 'polite');
      mountTarget().appendChild(root);
    } else if (root.parentNode !== mountTarget()) {
      mountTarget().appendChild(root); // follow the page into and out of fullscreen
    }
    root.classList.toggle('tl-fs', !!document.fullscreenElement);
    return root;
  }

  function removeHud() {
    const root = document.getElementById(HUD_ID);
    if (root) root.remove();
    hudSignature = '';
  }

  function setCategory(next) {
    chrome.runtime.sendMessage({ type: 'setCategory', category: next }, () => {
      category = next;
      renderHud();
      enforce();
    });
  }

  /**
   * What the corner says, by what the tab is doing:
   *   work + playing -> a quiet green tick: this is free of the limit
   *   entertainment + playing -> nothing standing, just the periodic reminder
   *   not playing (menus, search, a paused video) -> the explicit bar
   * The block overlay speaks for itself, so the corner stays out of its way.
   */
  function renderHud() {
    if (!hudEnabled || blocked) {
      removeHud();
      return;
    }
    const playing = isPlaying();
    const remaining = Math.max(0, limitMs - usedMs);
    const mode = category === 'work' ? 'work' : category === 'ent' ? 'ent' : 'unset';
    const signature = `${playing}|${mode}|${Math.round(remaining / 60000)}|${limitMs}`;
    const root = hudRoot();
    if (signature === hudSignature) return;
    hudSignature = signature;

    for (const old of root.querySelectorAll('.tl-pill')) old.remove();
    clearTimeout(settleTimer);

    const pill = el('div', 'tl-pill');

    if (playing && mode === 'work') {
      const check = el('span', 'tl-check', '✓');
      check.setAttribute('aria-hidden', 'true');
      pill.append(check, el('span', null, 'Educational'), el('span', 'tl-quiet', '· off the clock'));
      pill.title = 'Work & education time is tracked but never counts against the entertainment limit.';
      settleTimer = setTimeout(() => pill.classList.add('tl-settled'), CHIP_SETTLE_MS);
    } else if (playing) {
      return; // watching entertainment: the reminder does the talking
    } else {
      const dot = el('span', 'tl-dot');
      dot.style.background = mode === 'work' ? '#1a9b22' : mode === 'ent' ? '#ec7268' : '#fcc53d';
      const label = mode === 'work' ? 'Work & education' : mode === 'ent' ? 'Entertainment' : 'Uncategorised';
      pill.append(dot, el('span', null, label), el('span', 'tl-sep', '·'));
      if (mode === 'work') {
        pill.appendChild(el('span', 'tl-quiet', 'off the clock'));
      } else {
        pill.appendChild(el('span', 'tl-time', `${fmt(remaining)} left`));
      }
      const other = mode === 'work' ? 'ent' : 'work';
      const swap = el('button', 'tl-switch', other === 'work' ? 'Mark educational' : 'Mark entertainment');
      swap.addEventListener('click', () => setCategory(other));
      pill.appendChild(swap);
      pill.title = 'This tab’s mode, and what is left of today’s entertainment budget.';
    }

    root.appendChild(pill);
  }

  function showToast(remainingMs) {
    const root = hudRoot();
    const old = root.querySelector('.tl-toast');
    if (old) old.remove();
    clearTimeout(toastTimer);

    const toast = el('div', 'tl-toast');
    const dot = el('span', 'tl-dot');
    dot.style.background = '#ec7268';
    const text = el('span');
    text.appendChild(el('span', 'tl-big', fmt(remainingMs)));
    text.appendChild(document.createTextNode(' of entertainment left today'));
    toast.append(dot, text);
    root.appendChild(toast);

    toastTimer = setTimeout(() => {
      toast.classList.add('tl-out');
      setTimeout(() => toast.remove(), 320);
    }, TOAST_MS);
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
    removeHud();
    showOverlay();
  }

  function showOverlay() {
    ensureStyles();
    let root = document.getElementById(OVERLAY_ID);
    if (root) {
      const line = root.querySelector('.tl-sub');
      if (line) line.textContent = `${fmt(usedMs)} of your ${fmt(limitMs)} daily entertainment budget is spent.`;
      if (root.parentNode !== mountTarget()) mountTarget().appendChild(root);
      return;
    }

    root = el('div');
    root.id = OVERLAY_ID;
    const card = el('div', 'tl-card');
    card.appendChild(el('span', 'tl-tag', 'TubeLedger'));
    card.appendChild(el('h2', null, 'Daily entertainment limit reached'));
    card.appendChild(el('p', 'tl-sub', `${fmt(usedMs)} of your ${fmt(limitMs)} daily entertainment budget is spent.`));

    const row = el('div', 'tl-row');
    const workBtn = el('button', 'tl-primary', 'This is work & education');
    workBtn.addEventListener('click', () => setCategory('work'));
    const dashBtn = el('button', null, 'Open dashboard');
    dashBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'openDashboard' });
    });
    row.appendChild(workBtn);
    row.appendChild(dashBtn);
    card.appendChild(row);
    card.appendChild(el('p', 'tl-note', 'The budget resets at the start of your next day. Raise it in the dashboard if you mean to.'));

    root.appendChild(card);
    mountTarget().appendChild(root);
  }

  function removeOverlay() {
    const root = document.getElementById(OVERLAY_ID);
    if (root) root.remove();
  }

  // ---------------------------------------------------------------- wiring

  for (const evt of ['visibilitychange', 'focus', 'blur', 'pageshow']) {
    window.addEventListener(evt, () => { send(true); renderHud(); }, true);
  }
  document.addEventListener('visibilitychange', () => send(true), true);
  // Media events do not bubble; capture them at the document instead.
  for (const evt of ['play', 'pause', 'ended', 'emptied', 'volumechange']) {
    document.addEventListener(evt, () => {
      send(true);
      renderHud();
      if (evt === 'play') enforce();
    }, true);
  }
  window.addEventListener('yt-navigate-finish', () => { send(true); renderHud(); }, true);
  document.addEventListener('fullscreenchange', () => {
    hudSignature = '';   // the corner has to be re-mounted inside the fullscreen element
    renderHud();
    enforce();
  }, true);
  window.addEventListener('pagehide', () => {
    if (port) {
      try { port.disconnect(); } catch { /* already gone */ }
      port = null;
    }
  });

  setInterval(() => {
    send(false);
    renderHud();
    if (shouldBlock()) enforce();
  }, POLL_MS);

  connect();
})();
