import {
  CLASS_LABEL, dayBounds, dayKey, dayRange, fmtClock, fmtDuration,
  normalize, shiftDay, totals, clamp,
} from './lib/model.js';
import {
  getSettings, saveSettings, getDay, getDays, setDay, exportAll, importAll, newId, listDayKeys,
} from './lib/store.js';
import {
  renderTimeline, renderDailyBars, colorFor, prettyDate, hideTip,
} from './lib/charts.js';

const $ = (id) => document.getElementById(id);

let settings = null;
let viewKey = null;       // day being inspected
let segments = [];        // segments of viewKey
let history = [];         // [{key, totals}] for the chart
let mode = 'all';
let selectedId = null;
let snapshot = null;

// ------------------------------------------------------------------ load

async function boot() {
  settings = await getSettings();
  viewKey = dayKey(Date.now(), settings.dayStartHour);
  fillSettings();
  await reload();
  setInterval(async () => {
    // The day in progress keeps growing underneath us.
    if (viewKey === dayKey(Date.now(), settings.dayStartHour)) await reload();
  }, 5000);
  window.addEventListener('resize', () => { drawTimeline(); drawHistory(); });
}

async function reload() {
  snapshot = await chrome.runtime.sendMessage({ type: 'getSnapshot' }).catch(() => null);
  segments = normalize(await getDay(viewKey));
  const today = dayKey(Date.now(), settings.dayStartHour);
  const keys = dayRange(shiftDay(today, -29), today);
  const days = await getDays(keys);
  history = keys.map((key) => ({ key, totals: totals(days[key]) }));
  render();
}

function render() {
  $('day-title').textContent = prettyDate(viewKey);
  $('next-day').disabled = viewKey >= dayKey(Date.now(), settings.dayStartHour);
  drawStats();
  drawLegend();
  drawTimeline();
  drawHistory();
  drawEntries();
}

// ----------------------------------------------------------------- stats

function statCard({ key, label, value, sub, swatch, meter, over }) {
  const card = document.createElement('div');
  card.className = `stat${over ? ' over' : ''}`;
  const k = document.createElement('div');
  k.className = 'k';
  if (swatch) {
    const sw = document.createElement('span');
    sw.className = `swatch sw-${swatch}`;
    k.appendChild(sw);
  }
  k.appendChild(document.createTextNode(label));
  const v = document.createElement('div');
  v.className = 'v';
  v.textContent = value;
  card.append(k, v);
  if (sub) {
    const s = document.createElement('div');
    s.className = 's';
    s.textContent = sub;
    card.appendChild(s);
  }
  if (meter != null) {
    const bar = document.createElement('div');
    bar.className = 'meter';
    const fill = document.createElement('span');
    fill.style.width = `${clamp(meter * 100, 0, 100)}%`;
    bar.appendChild(fill);
    card.appendChild(bar);
  }
  card.dataset.key = key;
  return card;
}

function drawStats() {
  const t = totals(segments);
  const limitMs = settings.entLimitMin * 60000;
  const left = limitMs - t.ent;
  const host = $('stats');
  host.replaceChildren(
    statCard({
      key: 'ent', label: 'Entertainment', swatch: 'ent',
      value: fmtDuration(t.ent),
      sub: left >= 0 ? `${fmtDuration(left)} left of ${fmtDuration(limitMs)}` : `${fmtDuration(-left)} over the ${fmtDuration(limitMs)} limit`,
      meter: limitMs ? t.ent / limitMs : 0,
      over: left < 0,
    }),
    statCard({
      key: 'work', label: 'Work & education', swatch: 'work',
      value: fmtDuration(t.work),
      sub: t.byKind.work_bg ? `${fmtDuration(t.byKind.work_bg)} of it in the background` : 'all of it in view',
    }),
    statCard({
      key: 'menu', label: 'Menu & browsing', swatch: 'menu',
      value: fmtDuration(t.menu),
      sub: 'feeds, search, paused video',
    }),
    statCard({
      key: 'total', label: 'Total on YouTube',
      value: fmtDuration(t.total),
      sub: t.bg ? `${fmtDuration(t.fg)} in view · ${fmtDuration(t.bg)} background` : 'all of it in view',
    }),
  );
}

function drawLegend() {
  const rows = [
    ['work', false], ['ent', false], ['menu', false],
    ['work', true], ['ent', true], ['menu', true],
  ];
  const host = $('legend');
  host.replaceChildren();
  for (const [c, bg] of rows) {
    const item = document.createElement('span');
    const sw = document.createElement('span');
    sw.className = `swatch${bg ? ' sw-hatch' : ''}`;
    sw.style.background = colorFor(c, bg);
    item.append(sw, document.createTextNode(CLASS_LABEL[c] + (bg ? ' · background' : '')));
    host.appendChild(item);
  }

  const hist = $('history-legend');
  hist.replaceChildren();
  for (const c of (mode === 'ent' ? ['ent'] : ['work', 'ent', 'menu'])) {
    const item = document.createElement('span');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = colorFor(c, false);
    item.append(sw, document.createTextNode(CLASS_LABEL[c]));
    hist.appendChild(item);
  }
}

function drawTimeline() {
  const { start, end } = dayBounds(viewKey, settings.dayStartHour);
  renderTimeline($('timeline'), {
    segments, start, end, selectedId,
    onPick: (id) => {
      selectedId = id;
      drawTimeline();
      drawEntries();
      const row = document.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
      if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
  });
}

function drawHistory() {
  renderDailyBars($('history'), {
    days: history,
    mode,
    limitMs: settings.entLimitMin * 60000,
    selectedKey: viewKey,
    onPick: async (key) => {
      viewKey = key;
      selectedId = null;
      hideTip();
      await reload();
    },
  });
}

// --------------------------------------------------------------- entries

/** A clock time belongs to this logical day; times before the start hour roll over. */
function timeToMs(value, key) {
  const m = /^(\d{2}):(\d{2})$/.exec(value || '');
  if (!m) return NaN;
  const [y, mo, d] = key.split('-').map(Number);
  const h = +m[1];
  const min = +m[2];
  const dayOffset = h < settings.dayStartHour ? 1 : 0;
  return new Date(y, mo - 1, d + dayOffset, h, min, 0, 0).getTime();
}

function drawEntries() {
  const body = $('entries-body');
  body.replaceChildren();
  const runningId = snapshot && snapshot.current && viewKey === snapshot.dayKey
    ? lastSegmentId() : null;

  if (!segments.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'empty';
    td.textContent = 'Nothing tracked for this day yet.';
    tr.appendChild(td);
    body.appendChild(tr);
  }

  for (const seg of segments) {
    const tr = document.createElement('tr');
    tr.dataset.id = seg.id;
    if (seg.id === selectedId) tr.classList.add('sel');
    if (seg.id === runningId) tr.classList.add('running');

    // Type
    const typeTd = document.createElement('td');
    const sw = document.createElement('span');
    sw.className = `swatch${seg.bg ? ' sw-hatch' : ''}`;
    sw.style.background = colorFor(seg.c, seg.bg);
    const sel = document.createElement('select');
    for (const c of ['work', 'ent', 'menu']) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = CLASS_LABEL[c];
      if (c === seg.c) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => patch(seg.id, { c: sel.value, man: 1 }));
    typeTd.append(sw, sel);

    // Foreground / background
    const whereTd = document.createElement('td');
    const whereSel = document.createElement('select');
    for (const [val, text] of [['fg', 'Watching'], ['bg', 'Background']]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      if ((val === 'bg') === !!seg.bg) opt.selected = true;
      whereSel.appendChild(opt);
    }
    whereSel.addEventListener('change', () => patch(seg.id, { bg: whereSel.value === 'bg' ? 1 : 0, man: 1 }));
    whereTd.appendChild(whereSel);

    // Start
    const startTd = document.createElement('td');
    const startInput = document.createElement('input');
    startInput.type = 'time';
    startInput.value = fmtClock(seg.s);
    startInput.addEventListener('change', () => {
      const ms = timeToMs(startInput.value, viewKey);
      if (Number.isNaN(ms)) return;
      const len = seg.e - seg.s;
      patch(seg.id, { s: ms, e: ms + len, man: 1 });
    });
    startTd.appendChild(startInput);

    // Length in minutes
    const lenTd = document.createElement('td');
    const lenInput = document.createElement('input');
    lenInput.type = 'number';
    lenInput.min = '0';
    lenInput.step = '1';
    lenInput.value = String(Math.round((seg.e - seg.s) / 60000));
    lenInput.setAttribute('aria-label', 'Length in minutes');
    lenInput.addEventListener('change', () => {
      const mins = Math.max(0, Number(lenInput.value) || 0);
      patch(seg.id, { e: seg.s + mins * 60000, man: 1 });
    });
    const unit = document.createElement('span');
    unit.className = 'dim';
    unit.textContent = ' min';
    lenTd.append(lenInput, unit);

    // End (derived) + exact duration
    const endTd = document.createElement('td');
    endTd.className = 'num dim';
    endTd.textContent = `${fmtClock(seg.e)} · ${fmtDuration(seg.e - seg.s)}`;

    // Delete
    const actTd = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '✕';
    del.title = 'Delete this entry';
    del.setAttribute('aria-label', `Delete ${CLASS_LABEL[seg.c]} entry at ${fmtClock(seg.s)}`);
    del.addEventListener('click', () => remove(seg.id));
    actTd.appendChild(del);

    tr.append(typeTd, whereTd, startTd, lenTd, endTd, actTd);
    body.appendChild(tr);
  }

  const overlaps = countOverlaps();
  const warn = $('overlap-warn');
  warn.hidden = overlaps === 0;
  warn.textContent = overlaps
    ? `${overlaps} entr${overlaps === 1 ? 'y overlaps another' : 'ies overlap others'} — overlapping time is counted twice.`
    : '';
}

function lastSegmentId() {
  return segments.length ? segments[segments.length - 1].id : null;
}

function countOverlaps() {
  let n = 0;
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].s < segments[i - 1].e) n += 1;
  }
  return n;
}

async function patch(id, changes) {
  const { start, end } = dayBounds(viewKey, settings.dayStartHour);
  const next = segments.map((seg) => {
    if (seg.id !== id) return seg;
    const merged = { ...seg, ...changes };
    merged.s = clamp(merged.s, start, end - 1000);
    merged.e = clamp(merged.e, merged.s + 1000, end);
    return merged;
  });
  await commit(next);
}

async function remove(id) {
  await commit(segments.filter((seg) => seg.id !== id));
  if (selectedId === id) selectedId = null;
}

async function commit(next) {
  segments = normalize(next);
  await setDay(viewKey, segments);
  await chrome.runtime.sendMessage({ type: 'dataChanged' }).catch(() => {});
  segments = normalize(await getDay(viewKey));
  render();
}

$('add-entry').addEventListener('click', async () => {
  const { start, end } = dayBounds(viewKey, settings.dayStartHour);
  const last = segments[segments.length - 1];
  const s = clamp(last ? last.e : start + 12 * 3600000, start, end - 600000);
  const seg = { id: newId(s), s, e: Math.min(s + 600000, end), c: 'ent', bg: 0, man: 1 };
  selectedId = seg.id;
  await commit([...segments, seg]);
});

// ----------------------------------------------------------------- chrome

for (const btn of document.querySelectorAll('#mode-seg button')) {
  btn.addEventListener('click', () => {
    mode = btn.dataset.mode;
    for (const b of document.querySelectorAll('#mode-seg button')) {
      b.setAttribute('aria-pressed', String(b === btn));
    }
    drawLegend();
    drawHistory();
  });
}

$('prev-day').addEventListener('click', async () => {
  viewKey = shiftDay(viewKey, -1);
  selectedId = null;
  await reload();
});
$('next-day').addEventListener('click', async () => {
  const today = dayKey(Date.now(), settings.dayStartHour);
  if (viewKey >= today) return;
  viewKey = shiftDay(viewKey, 1);
  selectedId = null;
  await reload();
});
$('today').addEventListener('click', async () => {
  viewKey = dayKey(Date.now(), settings.dayStartHour);
  selectedId = null;
  await reload();
});

// --------------------------------------------------------------- settings

function fillSettings() {
  $('set-limit').value = settings.entLimitMin;
  $('set-daystart').value = settings.dayStartHour;
  $('set-default').value = settings.defaultCategory;
  $('set-idle').value = settings.idleSeconds;
  $('set-bg').checked = !!settings.countBackground;
  $('set-block').checked = !!settings.blockEnabled;
}

async function onSettingChange() {
  settings = await saveSettings({
    entLimitMin: clamp(Number($('set-limit').value) || 0, 0, 1440),
    dayStartHour: clamp(Number($('set-daystart').value) || 0, 0, 12),
    defaultCategory: $('set-default').value,
    idleSeconds: clamp(Number($('set-idle').value) || 60, 15, 600),
    countBackground: $('set-bg').checked,
    blockEnabled: $('set-block').checked,
  });
  fillSettings();
  await chrome.runtime.sendMessage({ type: 'settingsChanged' }).catch(() => {});
  const note = $('save-note');
  note.textContent = 'Saved';
  setTimeout(() => { note.textContent = ''; }, 1500);
  viewKey = dayKey(Date.now(), settings.dayStartHour);
  await reload();
}

for (const id of ['set-limit', 'set-daystart', 'set-default', 'set-idle', 'set-bg', 'set-block']) {
  $(id).addEventListener('change', onSettingChange);
}

$('export').addEventListener('click', async () => {
  const payload = await exportAll();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tubeledger-${dayKey(Date.now(), settings.dayStartHour)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    await importAll(payload);
    settings = await getSettings();
    fillSettings();
    await chrome.runtime.sendMessage({ type: 'settingsChanged' }).catch(() => {});
    await reload();
    $('save-note').textContent = 'Imported';
  } catch (err) {
    $('save-note').textContent = `Import failed: ${err.message}`;
  }
  e.target.value = '';
});

$('wipe').addEventListener('click', async () => {
  const days = await listDayKeys();
  const ok = window.confirm(`Erase ${days.length} day(s) of tracked time? This cannot be undone.`);
  if (!ok) return;
  await chrome.storage.local.clear();
  settings = await getSettings();
  fillSettings();
  await chrome.runtime.sendMessage({ type: 'settingsChanged' }).catch(() => {});
  await reload();
});

boot();
