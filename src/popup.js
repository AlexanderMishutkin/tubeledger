import { CLASS_LABEL, fmtDuration } from './lib/model.js';
import { prettyDate } from './lib/charts.js';
import { supported as fsSupported, backupIfDue } from './lib/fsbackup.js';

const $ = (id) => document.getElementById(id);
let activeTabId = null;
let snapshot = null;

async function findActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function refresh() {
  snapshot = await chrome.runtime.sendMessage({ type: 'getSnapshot' });
  if (snapshot) render();
}

function render() {
  const { totals: t, limitMs, baseLimitMs, carry, current, settings } = snapshot;
  const owed = (carry && carry.debt) || 0;
  const banked = (carry && carry.bonus) || 0;
  const charged = t.ent + owed;
  $('day-label').textContent = `${prettyDate(snapshot.dayKey)} · day starts ${String(settings.dayStartHour).padStart(2, '0')}:00`;

  // Budget
  const left = limitMs - charged;
  $('budget-left').textContent = left > 0 ? fmtDuration(left) : `${fmtDuration(-left)} over`;
  $('budget-sub').textContent = left > 0 ? 'entertainment left today' : 'past your daily limit';
  $('budget-used').textContent = `${fmtDuration(charged)} used`;
  $('budget-of').textContent = `of ${fmtDuration(limitMs)}`;
  const pct = limitMs > 0 ? Math.min(100, (charged / limitMs) * 100) : 0;
  $('meter-fill').style.width = `${pct}%`;
  $('meter').classList.toggle('over', left <= 0);

  // Where today's ceiling came from — banked yesterday, or already owed.
  const carryLine = $('carry-line');
  if (banked > 0) {
    carryLine.textContent = `${fmtDuration(baseLimitMs)} limit + ${fmtDuration(banked)} banked from yesterday`;
    carryLine.className = 'carry-line banked';
    carryLine.hidden = false;
  } else if (owed > 0) {
    carryLine.textContent = `${fmtDuration(owed)} of yesterday's overtime already charged to today`;
    carryLine.className = 'carry-line owed';
    carryLine.hidden = false;
  } else {
    carryLine.hidden = true;
  }

  // Day composition bar + rows
  const bar = $('day-bar');
  bar.replaceChildren();
  const parts = [
    ['work', false], ['work', true], ['ent', false], ['ent', true], ['menu', false], ['menu', true],
  ];
  const byKind = t.byKind || {};
  const grand = Math.max(1, t.total);
  for (const [c, bg] of parts) {
    const ms = byKind[`${c}_${bg ? 'bg' : 'fg'}`] || 0;
    if (ms <= 0) continue;
    const span = document.createElement('span');
    span.style.width = `${(ms / grand) * 100}%`;
    span.style.background = `var(--c-${c}${bg ? '-bg' : ''})`;
    if (bg) span.classList.add('hatch');
    bar.appendChild(span);
  }

  const rows = $('rows');
  rows.replaceChildren();
  for (const c of ['work', 'ent', 'menu']) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    const sw = document.createElement('span');
    sw.className = `swatch sw-${c}`;
    name.appendChild(sw);
    name.appendChild(document.createTextNode(CLASS_LABEL[c]));
    const val = document.createElement('span');
    val.className = 'val num';
    val.textContent = fmtDuration(t[c]);
    li.append(name, val);
    rows.appendChild(li);
  }
  const totalLi = document.createElement('li');
  const totalName = document.createElement('span');
  totalName.className = 'sub';
  totalName.textContent = `Total on YouTube · ${fmtDuration(t.bg)} of it in the background`;
  const totalVal = document.createElement('span');
  totalVal.className = 'val num sub';
  totalVal.textContent = fmtDuration(t.total);
  totalLi.append(totalName, totalVal);
  rows.appendChild(totalLi);

  // What is being counted right now
  const dot = $('state-dot');
  const text = $('state-text');
  dot.className = 'dot';
  if (!current) {
    dot.style.background = '';
    text.textContent = snapshot.idleState !== 'active' ? 'idle — not counting' : 'not counting';
  } else {
    dot.style.background = `var(--c-${current.c}${current.bg ? '-bg' : ''})`;
    if (current.bg) dot.classList.add('hatch');
    text.textContent = `${CLASS_LABEL[current.c]}${current.bg ? ' · background' : ''}`;
  }

  renderCategory();
}

function renderCategory() {
  const cat = activeTabId != null ? snapshot.tabCategories[activeTabId] : undefined;
  const known = cat === 'work' || cat === 'ent';
  for (const btn of document.querySelectorAll('.seg button')) {
    btn.setAttribute('aria-pressed', String(known && btn.dataset.cat === cat));
    btn.disabled = activeTabId == null || cat === undefined;
  }
  const note = $('tab-note');
  if (activeTabId == null || cat === undefined) {
    note.textContent = 'Open a YouTube tab to set its category.';
  } else if (cat === 'unset') {
    note.textContent = 'Uncategorised — this time books as menu (yellow) until you pick.';
  } else {
    note.textContent = 'New tabs start as '
      + (snapshot.settings.defaultCategory === 'work' ? 'work & education'
        : snapshot.settings.defaultCategory === 'ent' ? 'entertainment' : 'uncategorised')
      + '. Change that in the dashboard.';
  }
}

for (const btn of document.querySelectorAll('.seg button')) {
  btn.addEventListener('click', async () => {
    if (activeTabId == null) return;
    snapshot = await chrome.runtime.sendMessage({
      type: 'setCategory', tabId: activeTabId, category: btn.dataset.cat,
    });
    if (snapshot) render();
  });
}

/**
 * The popup is the page that gets opened most often, so it is where the daily
 * backup actually happens: one silent write, no picker, no download bubble.
 */
async function backupOnOpen() {
  if (!snapshot || !snapshot.settings.backupEnabled || !fsSupported()) return;
  const meta = await backupIfDue(snapshot.dayKey);
  const hint = $('backup-hint');
  if (meta && meta.needsReconnect) {
    hint.textContent = 'Backup folder needs reconnecting — open the dashboard';
    hint.hidden = false;
  }
}

$('backup-hint').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'openDashboard' });
  window.close();
});

$('open-dash').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'openDashboard' });
  window.close();
});

(async () => {
  const tab = await findActiveTab();
  activeTabId = tab ? tab.id : null;
  await refresh();
  backupOnOpen();
  setInterval(refresh, 1000);
})();
