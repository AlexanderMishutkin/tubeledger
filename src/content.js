// Runs on youtube.com. Three jobs:
//   1. report what this tab is doing (playing? visible? focused?) to the worker
//   2. show the corner indicator: mode, budget left, and the periodic reminder
//   3. pause entertainment playback once the daily limit is spent
//
// It reads no video titles, no channel names, no URLs beyond the path shape.
// Built with createElement/textContent only — no innerHTML, no eval.
(() => {
  'use strict';

  // Bumped with the manifest (a test keeps the two in step). Reloading an
  // unpacked extension does NOT replace this script in tabs that are already
  // open, so a tab can go on running an old build against a new worker. When
  // the worker reports a different version, the pill says so.
  const BUILD = '0.6.1';

  const POLL_MS = 2000;
  const HEARTBEAT_MS = 10000;
  const OVERLAY_ID = 'tubeledger-limit-overlay';
  const HUD_ID = 'tubeledger-hud';
  const STYLE_ID = 'tubeledger-style';
  const TOAST_MS = 7000;

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
  let workerBuild = '';
  let restriction = 'none';   // none | soft | hard
  let remainingMs = 0;
  let sweepScheduled = false;

  let hudSignature = '';
  let toastTimer = null;
  let pillNode = null;   // lives in YouTube's masthead, or in the floating corner

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
        workerBuild = msg.build || '';
        restriction = msg.restriction || 'none';
        remainingMs = typeof msg.remainingMs === 'number' ? msg.remainingMs : 0;
        enforce();
        renderHud();
        sweep();
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
        backdrop-filter: blur(6px); max-width: 320px;
      }
      #${HUD_ID} .tl-dot, .tl-dock .tl-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
      .tl-work-dot { background: #1a9b22; }
      .tl-ent-dot { background: #ec7268; }
      .tl-menu-dot { background: #fcc53d; }
      /* Docked in YouTube's own masthead, next to Create and the bell. */
      .tl-dock {
        display: inline-flex; align-items: center; gap: 8px; flex: none;
        height: 32px; padding: 0 6px 0 11px; margin: 0 8px 0 0;
        border-radius: 999px; white-space: nowrap;
        font: 500 12px/1 "Roboto", system-ui, -apple-system, sans-serif;
        background: rgba(0, 0, 0, .05); border: 1px solid rgba(0, 0, 0, .12); color: #0f0f0f;
      }
      .tl-dock.tl-dark {
        background: rgba(255, 255, 255, .08); border-color: rgba(255, 255, 255, .16); color: #f1f1f1;
      }
      .tl-dock.tl-dock-plain { padding-right: 12px; }
      .tl-dock .tl-sep { opacity: .45; }
      .tl-dock .tl-quiet { opacity: .7; font-weight: 400; }
      .tl-dock .tl-time { font-variant-numeric: tabular-nums; }
      .tl-dock .tl-check {
        width: 15px; height: 15px; border-radius: 50%; flex: none;
        display: flex; align-items: center; justify-content: center;
        background: #1a9b22; color: #fff; font-size: 10px; font-weight: 700;
      }
      .tl-dock .tl-switch {
        font: inherit; font-size: 11px; cursor: pointer; border: 0; border-radius: 999px;
        padding: 5px 9px; background: rgba(0, 0, 0, .07); color: inherit;
      }
      .tl-dock.tl-dark .tl-switch { background: rgba(255, 255, 255, .12); }
      .tl-dock .tl-switch:hover { filter: brightness(.94); }
      .tl-dock.tl-dark .tl-switch:hover { filter: brightness(1.3); }
      /* A narrow window needs the room for YouTube's own buttons. */
      @media (max-width: 1150px) { .tl-dock .tl-mode { display: none; } .tl-dock .tl-sep { display: none; } }
      @media (max-width: 900px) { .tl-dock .tl-switch { display: none; } }

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

      /* A hidden card keeps its exact box. Collapsing it would make the page
         shorter, YouTube would fetch another screenful to fill the gap, and that
         loop does not end — an endless scroll nobody asked for. So the card stays
         where it is and gets painted out instead.
         Hiding by visibility covers every descendant however the card is built
         (the caption is a second link, outside the thumbnail, so hiding the
         thumbnail alone left the title sitting there); the pseudo-element opts
         back in to draw the square. If a card is shaped oddly enough that the
         square misses, what is left is blank space of the same height — never
         leaked content, never a changed layout. */
      [${HIDE_ATTR}] {
        visibility: hidden !important;
        pointer-events: none !important;
      }
      [${HIDE_ATTR}][data-tl-paint="rel"] { position: relative !important; }
      [${HIDE_ATTR}]::after {
        content: ''; visibility: visible;
        position: absolute; inset: 0;
        background: #000; border-radius: 12px;
      }
      [data-tl-search="off"] {
        opacity: .35 !important; pointer-events: none !important; filter: grayscale(1);
      }
      #${BANNER_ID} {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        margin: 0 0 16px; padding: 12px 14px; border-radius: 12px;
        background: rgba(22, 22, 21, .92); color: #fcfcfb;
        border: 1px solid rgba(255, 255, 255, .14); border-left: 3px solid #ec7268;
        font: 500 13px/1.4 "Roboto", system-ui, -apple-system, sans-serif;
      }
      #${BANNER_ID} .tl-b-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #ec7268; flex: none;
      }
      #${BANNER_ID} .tl-b-text { flex: 1; min-width: 180px; }
      #${BANNER_ID} button {
        font: inherit; font-size: 12px; cursor: pointer; border: 0; border-radius: 999px;
        padding: 6px 12px; background: #1a9b22; color: #fff;
      }
      #${BANNER_ID} button:hover { filter: brightness(1.1); }

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

  /**
   * YouTube's own masthead row, where the pill belongs: it is real header space,
   * so the pill never covers a video, a thumbnail or the filter chips. Returns
   * null when there is nothing usable to dock into — and the floating corner
   * takes over.
   *
   * Fullscreen is the case worth spelling out. YouTube does not remove the
   * masthead there, it slides it out of the way, so it keeps a full-size box and
   * "does it have a size" is not enough to tell: a pill docked into it in
   * fullscreen is simply invisible. Any fullscreen at all means float instead.
   */
  function mastheadSlot() {
    if (document.fullscreenElement) return null;
    const slot = document.querySelector('ytd-masthead #end #buttons')
      || document.querySelector('ytd-masthead #buttons')
      || document.querySelector('#masthead #end');
    if (!slot) return null;
    if (slot.checkVisibility && !slot.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) {
      return null;
    }
    const rect = slot.getBoundingClientRect();
    const onScreen = rect.bottom > 0 && rect.top < (window.innerHeight || 0);
    return rect.width > 0 && rect.height > 0 && onScreen ? slot : null;
  }

  /** The floating corner: home of the reminder, and of the pill when undocked. */
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

  function removeFloatRoot() {
    const root = document.getElementById(HUD_ID);
    if (root) root.remove();
  }

  function removeHud() {
    if (pillNode) pillNode.remove();
    pillNode = null;
    removeFloatRoot();
    hudSignature = '';
  }

  function setCategory(next) {
    chrome.runtime.sendMessage({ type: 'setCategory', category: next }, () => {
      category = next;
      renderHud();
      enforce();
      sweep();
    });
  }

  /**
   * What the indicator says, by what the tab is doing:
   *   work + playing -> a quiet green tick: this is free of the limit
   *   entertainment + playing -> nothing standing, just the periodic reminder
   *   not playing (menus, search, a paused video) -> the explicit bar
   * The block overlay speaks for itself, so the indicator stays out of its way.
   */
  function isStale() {
    return !!workerBuild && workerBuild !== BUILD;
  }

  function renderHud() {
    if (blocked || (!hudEnabled && !isStale())) {
      removeHud();
      return;
    }
    const playing = isPlaying();
    const remaining = Math.max(0, limitMs - usedMs);
    const mode = category === 'work' ? 'work' : category === 'ent' ? 'ent' : 'unset';
    const slot = mastheadSlot();
    // A stale tab always shows, even mid-video: one refresh is all it needs.
    const stale = isStale();
    const wanted = stale || !(playing && mode !== 'work'); // watching entertainment: say nothing
    const signature = `${stale}|${playing}|${mode}|${Math.round(remaining / 60000)}|${limitMs}|${!!slot}|${isDark()}`;

    // Polymer re-renders the masthead often enough that a detached pill is
    // normal, not an error: rebuild whenever ours is no longer in the document.
    const attached = pillNode && pillNode.isConnected;
    if (signature === hudSignature && (!wanted || attached)) return;
    hudSignature = signature;

    if (pillNode) pillNode.remove();
    pillNode = null;
    if (!wanted) {
      if (!document.querySelector(`#${HUD_ID} .tl-toast`)) removeFloatRoot();
      return;
    }

    pillNode = stale ? buildStalePill(!!slot) : buildPill(playing, mode, remaining, !!slot);
    if (slot) {
      slot.insertBefore(pillNode, slot.firstChild);
      if (!document.querySelector(`#${HUD_ID} .tl-toast`)) removeFloatRoot();
    } else {
      hudRoot().appendChild(pillNode); // fullscreen, or a masthead we cannot find
    }
  }

  /** YouTube stamps `dark` on <html> for its dark theme; nothing there means light. */
  function isDark() {
    return document.documentElement.hasAttribute('dark');
  }

  function buildStalePill(docked) {
    ensureStyles();
    const pill = el('div', docked ? 'tl-dock' : 'tl-pill');
    if (docked && isDark()) pill.classList.add('tl-dark');
    pill.append(el('span', 'tl-dot tl-menu-dot'), el('span', 'tl-mode', 'TubeLedger updated'));
    const refresh = el('button', 'tl-switch', 'Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      location.reload();
    });
    pill.appendChild(refresh);
    pill.title = `This tab still runs TubeLedger ${BUILD}; the extension is now ${workerBuild}. Refresh to catch up.`;
    return pill;
  }

  function buildPill(playing, mode, remaining, docked) {
    ensureStyles();
    const pill = el('div', docked ? 'tl-dock' : 'tl-pill');
    if (docked && isDark()) pill.classList.add('tl-dark');

    if (playing && mode === 'work') {
      const check = el('span', 'tl-check', '\u2713');
      check.setAttribute('aria-hidden', 'true');
      pill.append(check, el('span', null, 'Educational'), el('span', 'tl-quiet', '· off the clock'));
      pill.title = 'Work & education time is tracked but never counts against the entertainment limit.';
      pill.classList.add('tl-dock-plain');
      return pill;
    }

    const dot = el('span', `tl-dot tl-${mode === 'unset' ? 'menu' : mode}-dot`);
    const label = mode === 'work' ? 'Work & education' : mode === 'ent' ? 'Entertainment' : 'Uncategorised';
    pill.append(dot, el('span', 'tl-mode', label), el('span', 'tl-sep', '·'));
    pill.appendChild(mode === 'work'
      ? el('span', 'tl-quiet', 'off the clock')
      : el('span', 'tl-time', `${fmt(remaining)} left`));

    const other = mode === 'work' ? 'ent' : 'work';
    const swap = el('button', 'tl-switch', other === 'work' ? 'Mark educational' : 'Mark entertainment');
    swap.type = 'button';
    swap.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setCategory(other);
    });
    pill.appendChild(swap);
    pill.title = `This tab is ${label.toLowerCase()}. ${mode === 'work' ? 'It does not touch the limit.' : `${fmt(remaining)} of today's entertainment budget is left.`}`;
    return pill;
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

  // ------------------------------------------------- thinning the temptation
  //
  // As the budget runs down, YouTube stops offering what you cannot afford:
  //   soft (under 20m left)  recommendations longer than what is left × 1.9
  //   hard (under 5m left)   every recommendation, the home feed, and search
  // Marking the tab educational lifts all of it at once, which is the only way
  // out that does not involve spending the budget.
  //
  // Nothing here writes a style attribute onto YouTube's own nodes — Polymer
  // wipes those on re-render. It sets a data attribute and lets our stylesheet
  // do the hiding, which survives.

  const SUGGESTION_FACTOR = 1.9;
  const HIDE_ATTR = 'data-tl-hide';
  const BANNER_ID = 'tubeledger-thinned';
  const DURATION_RE = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)$/;

  function parseDuration(text) {
    const m = DURATION_RE.exec((text || '').trim());
    if (!m) return null;
    return ((Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3])) * 1000;
  }

  /**
   * The duration badge on a card. Class names change every few months, so the
   * badge is found by the shape of its text, with class hints only as a tiebreak.
   */
  function durationOf(card) {
    let hinted = null;
    let plain = null;
    for (const node of card.querySelectorAll('span, div, yt-formatted-string')) {
      if (node.firstElementChild) continue; // leaves only: the badge is a text node
      const ms = parseDuration(node.textContent);
      if (ms === null) continue;
      const hint = node.closest('[class*="badge"], [class*="time-status"], [class*="thumbnail"]');
      if (hint && hinted === null) hinted = ms;
      if (plain === null) plain = ms;
    }
    return hinted !== null ? hinted : plain;
  }

  const LINK_SEL = 'a[href*="/watch?v="], a[href*="/shorts/"]';

  /** The video a link points at, or null. Ids only — no titles, no queries kept. */
  function videoIdOf(link) {
    const href = link.getAttribute('href') || '';
    const watch = /[?&]v=([\w-]+)/.exec(href);
    if (watch) return watch[1];
    const short = /\/shorts\/([\w-]+)/.exec(href);
    return short ? short[1] : null;
  }

  /** True while an ancestor is still about this one video and nothing else. */
  function coversOneVideo(node, id) {
    for (const link of node.querySelectorAll(LINK_SEL)) {
      const other = videoIdOf(link);
      if (other && other !== id) return false;
    }
    return true;
  }

  /**
   * The card a link belongs to: walk up while the ancestor is still about this
   * one video, and stop before the one that covers several. Structure, not class
   * names, so a YouTube redesign does not silently switch the feature off.
   *
   * Counting *links* here was wrong: a sidebar card holds two of them, the
   * thumbnail and the title, so the walk stopped at the thumbnail and the title
   * stayed on the page. Distinct video ids is the honest test of "one card".
   */
  function cardFor(link, root) {
    const id = videoIdOf(link);
    let node = link;
    for (let i = 0; i < 8; i += 1) {
      const parent = node.parentElement;
      if (!parent || parent === root || parent === document.body) return node;
      if (id && !coversOneVideo(parent, id)) return node;
      if (!id && parent.querySelectorAll(LINK_SEL).length > 1) return node;
      node = parent;
    }
    return node;
  }

  function cardsIn(root) {
    const cards = [];
    let last = null;
    // querySelectorAll is in document order, so every link of a card follows the
    // first one: checking the last card found is enough to skip the rest of them.
    for (const link of root.querySelectorAll(LINK_SEL)) {
      if (last && last.contains(link)) continue;
      const card = cardFor(link, root);
      if (!card || card === root) continue;
      last = card;
      if (!cards.includes(card)) cards.push(card);
    }
    return cards;
  }

  /**
   * YouTube keeps the watch page in the DOM after you navigate back to the feed,
   * just hidden — so "the element exists" is not the same as "you can see it".
   * A hidden root would swallow the banner and waste a sweep on cards nobody
   * is looking at.
   */
  function onScreen(node) {
    if (!node) return false;
    if (node.checkVisibility) return node.checkVisibility({ checkVisibilityCSS: true });
    return !!(node.offsetParent || node.getClientRects().length);
  }

  function suggestionRoots() {
    const roots = [];
    const push = (node) => {
      if (node && onScreen(node) && !roots.includes(node)) roots.push(node);
    };
    push(document.querySelector('ytd-watch-next-secondary-results-renderer'));
    push(document.querySelector('#secondary #related'));
    push(document.querySelector('#secondary'));
    return roots;
  }

  function homeRoots() {
    if (!/^\/(|feed\/(subscriptions|trending|explore))\/?$/.test(location.pathname)) return [];
    const roots = [];
    const push = (node) => {
      if (node && onScreen(node) && !roots.includes(node)) roots.push(node);
    };
    push(document.querySelector('ytd-rich-grid-renderer'));
    push(document.querySelector('ytd-browse[role="main"] #contents'));
    push(document.querySelector('#primary #contents'));
    return roots;
  }

  function mark(node, reason) {
    if (!node.hasAttribute(HIDE_ATTR)) {
      // The black square is drawn by a pseudo-element, which needs a positioned
      // card to sit on. Only a statically positioned one is nudged to relative —
      // that changes no geometry — and anything YouTube already positions is left
      // exactly as it is.
      const positioned = getComputedStyle(node).position !== 'static';
      if (!positioned) node.setAttribute('data-tl-paint', 'rel');
    }
    if (node.getAttribute(HIDE_ATTR) !== reason) node.setAttribute(HIDE_ATTR, reason);
  }

  function unmarkAll() {
    for (const node of document.querySelectorAll(`[${HIDE_ATTR}]`)) {
      node.removeAttribute(HIDE_ATTR);
      node.removeAttribute('data-tl-paint');
    }
    const banner = document.getElementById(BANNER_ID);
    if (banner) banner.remove();
    const search = searchBox();
    if (search) search.removeAttribute('data-tl-search');
  }

  function searchBox() {
    return document.querySelector('ytd-searchbox') || document.querySelector('#search-form')
      || document.querySelector('#center');
  }

  /** The active restriction for this tab, which educational mode always clears. */
  function activeRestriction() {
    if (!hudEnabled) return 'none';
    if (category !== 'ent') return 'none';
    if (document.fullscreenElement) return 'none';
    return restriction;
  }

  function sweep() {
    const level = activeRestriction();
    if (level === 'none') {
      unmarkAll();
      return;
    }

    const budget = Math.max(0, remainingMs) * SUGGESTION_FACTOR;
    let thinned = 0;
    for (const root of suggestionRoots()) {
      for (const card of cardsIn(root)) {
        if (level === 'hard') {
          mark(card, 'all');
          thinned += 1;
          continue;
        }
        const ms = durationOf(card);
        // Only hide what can be shown to be too long: an unreadable card stays.
        if (ms !== null && ms > budget) {
          mark(card, 'long');
          thinned += 1;
        } else if (card.hasAttribute(HIDE_ATTR)) {
          card.removeAttribute(HIDE_ATTR);
          card.removeAttribute('data-tl-paint');
        }
      }
    }

    if (level === 'hard') {
      for (const root of homeRoots()) {
        for (const card of cardsIn(root)) {
          mark(card, 'all');
          thinned += 1;
        }
      }
      const search = searchBox();
      if (search) search.setAttribute('data-tl-search', 'off');
      showBanner();
    } else {
      const banner = document.getElementById(BANNER_ID);
      if (banner) banner.remove();
      const search = searchBox();
      if (search) search.removeAttribute('data-tl-search');
      if (thinned > 0) showBanner();
    }
  }

  /** An empty page must never look broken: say who emptied it, and why. */
  function showBanner() {
    const host = suggestionRoots()[0] || homeRoots()[0];
    if (!host) return;
    let banner = document.getElementById(BANNER_ID);
    const hard = activeRestriction() === 'hard';
    const text = hard
      ? `${fmt(Math.max(0, remainingMs))} of entertainment left — the recommendations are blacked out.`
      : `${fmt(Math.max(0, remainingMs))} left — anything longer than ${fmt(Math.max(0, remainingMs) * SUGGESTION_FACTOR)} is blacked out.`;
    if (banner) {
      const line = banner.querySelector('.tl-b-text');
      if (line) line.textContent = text;
      if (banner.parentNode !== host) host.insertBefore(banner, host.firstChild);
      return;
    }
    ensureStyles();
    banner = el('div');
    banner.id = BANNER_ID;
    banner.appendChild(el('span', 'tl-b-dot'));
    banner.appendChild(el('span', 'tl-b-text', text));
    const button = el('button', null, 'Mark educational');
    button.type = 'button';
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setCategory('work');
    });
    banner.appendChild(button);
    host.insertBefore(banner, host.firstChild);
  }

  /** Enter in a disabled search box does nothing; the click-through is blocked in CSS. */
  function guardSearch(e) {
    if (activeRestriction() !== 'hard') return;
    const box = searchBox();
    if (!box || !e.target || !box.contains(e.target)) return;
    if (e.type === 'submit' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function scheduleSweep() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    setTimeout(() => {
      sweepScheduled = false;
      sweep();
    }, 250);
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

  document.addEventListener('submit', guardSearch, true);
  document.addEventListener('keydown', guardSearch, true);

  // YouTube fills the sidebar and the feed long after the page "loads", and
  // again on every soft navigation, so the sweep follows the DOM rather than
  // running once.
  const observer = new MutationObserver(() => {
    if (activeRestriction() !== 'none') scheduleSweep();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => {
    send(false);
    renderHud();
    sweep();
    if (shouldBlock()) enforce();
  }, POLL_MS);

  connect();
})();
