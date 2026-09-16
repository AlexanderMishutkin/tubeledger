// Hand-rolled SVG charts. No libraries, no innerHTML — every node is created
// through the DOM API so the whole extension stays auditable by reading it.
import { CLASS_LABEL, fmtClock, fmtDuration, stackParts } from './model.js';

const NS = 'http://www.w3.org/2000/svg';

export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Live theme tokens, so charts follow light/dark without a second palette. */
export function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name) => cs.getPropertyValue(name).trim();
  return {
    work: get('--c-work'),
    ent: get('--c-ent'),
    menu: get('--c-menu'),
    workBg: get('--c-work-bg'),
    entBg: get('--c-ent-bg'),
    menuBg: get('--c-menu-bg'),
    over: get('--c-ent-over'),
    overHot: get('--c-ent-over-hot'),
    surface: get('--surface-1'),
    line: get('--line'),
    lineStrong: get('--line-strong'),
    text2: get('--text-2'),
    text3: get('--text-3'),
  };
}

export function colorFor(c, bg, t = tokens()) {
  if (c === 'work') return bg ? t.workBg : t.work;
  if (c === 'ent') return bg ? t.entBg : t.ent;
  return bg ? t.menuBg : t.menu;
}

/**
 * Shared paint: the 45° stripes that mark background playback, and — for time
 * spent past the daily limit — a gradient that runs hot towards the top plus a
 * glow around the mark. Over-limit time is the one thing in this chart that is
 * supposed to grab you, so it is the one thing allowed to be loud.
 */
function addDefs(svg, t) {
  const defs = svgEl('defs');

  const pattern = svgEl('pattern', {
    id: 'tl-stripes', width: 6, height: 6,
    patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)',
  });
  pattern.appendChild(svgEl('line', {
    x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#ffffff', 'stroke-width': 2, 'stroke-opacity': 0.5,
  }));
  defs.appendChild(pattern);

  if (t) {
    const grad = svgEl('linearGradient', { id: 'tl-over', x1: 0, y1: 1, x2: 0, y2: 0 });
    grad.appendChild(svgEl('stop', { offset: 0, 'stop-color': t.over }));
    grad.appendChild(svgEl('stop', { offset: 1, 'stop-color': t.overHot }));
    defs.appendChild(grad);

    const glow = svgEl('filter', {
      id: 'tl-glow', x: '-120%', y: '-120%', width: '340%', height: '340%',
      'color-interpolation-filters': 'sRGB',
    });
    glow.appendChild(svgEl('feDropShadow', {
      dx: 0, dy: 0, stdDeviation: 2.5, 'flood-color': t.overHot, 'flood-opacity': 0.85,
    }));
    glow.appendChild(svgEl('feDropShadow', {
      dx: 0, dy: 0, stdDeviation: 6, 'flood-color': t.over, 'flood-opacity': 0.6,
    }));
    defs.appendChild(glow);
  }

  svg.appendChild(defs);
}

// --------------------------------------------------------------- tooltip

let tipEl = null;

function tip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'chart-tip';
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

export function showTip(evt, lines) {
  const node = tip();
  node.replaceChildren();
  for (const line of lines) {
    const row = document.createElement('div');
    if (line.swatch) {
      const sw = document.createElement('span');
      sw.className = `swatch${line.hatch ? ' sw-hatch' : ''}`;
      sw.style.background = line.swatch;
      row.appendChild(sw);
    }
    row.appendChild(document.createTextNode(line.text));
    if (line.strong) row.style.fontWeight = '600';
    if (line.dim) row.style.color = 'var(--text-3)';
    node.appendChild(row);
  }
  node.hidden = false;
  const pad = 14;
  const rect = node.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
  node.style.left = `${Math.max(8, x)}px`;
  node.style.top = `${Math.max(8, y)}px`;
}

export function hideTip() {
  if (tipEl) tipEl.hidden = true;
}

// -------------------------------------------------------------- timeline

/**
 * The day as one lane, 04:00 -> 04:00. Each segment is a rect; background
 * playback is the muted step plus the 45° hatch.
 * @param {object} opts {segments, start, end, onPick, selectedId}
 */
export function renderTimeline(host, opts) {
  const { segments, start, end, onPick, selectedId } = opts;
  const t = tokens();
  const width = Math.max(320, host.clientWidth || 640);
  const laneY = 8;
  const laneH = 46;
  const axisH = 20;
  const height = laneY + laneH + axisH;
  const span = end - start;

  host.replaceChildren();
  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });
  svg.setAttribute('aria-label', 'Timeline of today, 4am to 4am');
  addDefs(svg);

  const x = (ms) => ((ms - start) / span) * width;

  // Lane bed
  svg.appendChild(svgEl('rect', {
    x: 0, y: laneY, width, height: laneH, rx: 6, fill: t.surface, stroke: t.line,
  }));

  // Hairline hour ticks every two hours, with labels under the lane.
  for (let h = 0; h <= 24; h += 2) {
    const ms = start + h * 3600000;
    const px = Math.round(x(ms)) + 0.5;
    if (h > 0 && h < 24) {
      svg.appendChild(svgEl('line', {
        x1: px, y1: laneY, x2: px, y2: laneY + laneH, stroke: t.line, 'stroke-width': 1,
      }));
    }
    const label = svgEl('text', {
      x: Math.min(width - 12, Math.max(10, px)), y: laneY + laneH + 14,
      'text-anchor': h === 0 ? 'start' : (h === 24 ? 'end' : 'middle'),
      fill: t.text3, 'font-size': 10,
    });
    label.textContent = new Date(ms).getHours().toString().padStart(2, '0');
    svg.appendChild(label);
  }

  // Segments, 2px surface gap between touching ones.
  for (const seg of segments) {
    const x0 = x(Math.max(seg.s, start));
    const x1 = x(Math.min(seg.e, end));
    const w = Math.max(2, x1 - x0 - 1);
    const fill = colorFor(seg.c, seg.bg, t);
    const group = svgEl('g', { class: 'tl-seg', tabindex: 0, role: 'button' });
    group.setAttribute('aria-label',
      `${CLASS_LABEL[seg.c]}${seg.bg ? ', background' : ''}, ${fmtClock(seg.s)} to ${fmtClock(seg.e)}, ${fmtDuration(seg.e - seg.s)}`);
    group.appendChild(svgEl('rect', {
      x: x0, y: laneY + 3, width: w, height: laneH - 6, rx: 2, fill,
    }));
    if (seg.bg) {
      group.appendChild(svgEl('rect', {
        x: x0, y: laneY + 3, width: w, height: laneH - 6, rx: 2, fill: 'url(#tl-stripes)',
      }));
    }
    if (seg.id === selectedId) {
      group.appendChild(svgEl('rect', {
        x: x0 - 1, y: laneY + 1, width: w + 2, height: laneH - 2, rx: 3,
        fill: 'none', stroke: t.text2, 'stroke-width': 2,
      }));
    }
    const lines = [
      { text: CLASS_LABEL[seg.c] + (seg.bg ? ' · background' : ''), swatch: fill, hatch: !!seg.bg, strong: true },
      { text: `${fmtClock(seg.s)} – ${fmtClock(seg.e)} · ${fmtDuration(seg.e - seg.s)}` },
      { text: seg.man ? 'edited by hand' : 'tracked', dim: true },
    ];
    group.addEventListener('mousemove', (e) => showTip(e, lines));
    group.addEventListener('mouseleave', hideTip);
    group.addEventListener('click', () => onPick && onPick(seg.id));
    group.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick && onPick(seg.id); }
    });
    svg.appendChild(group);
  }

  // "Now" marker, when the day being shown is the one in progress.
  const now = Date.now();
  if (now > start && now < end) {
    const px = Math.round(x(now)) + 0.5;
    svg.appendChild(svgEl('line', {
      x1: px, y1: laneY - 4, x2: px, y2: laneY + laneH + 4,
      stroke: t.text2, 'stroke-width': 1,
    }));
    svg.appendChild(svgEl('circle', { cx: px, cy: laneY - 4, r: 3, fill: t.text2 }));
  }

  host.appendChild(svg);
}

// --------------------------------------------------- stacked daily columns

function roundedTopPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} `
       + `L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

/**
 * One column per day. Entertainment sits at the bottom of every stack so it can
 * be read against the limit line, and whatever went over the line is drawn in
 * its own colour.
 * @param {object} opts {days:[{key, totals}], mode:'all'|'ent', limitMs, onPick, selectedKey}
 */
export function renderDailyBars(host, opts) {
  const { days, mode, limitMs, onPick, selectedKey } = opts;
  const t = tokens();
  const width = Math.max(360, host.clientWidth || 720);
  const padL = 38;
  const padR = 10;
  const padT = 12;
  const padB = 26;
  const height = 210;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const stackOrder = mode === 'ent' ? ['ent'] : ['ent', 'work', 'menu'];
  const dayTotal = (d) => stackOrder.reduce((sum, c) => sum + (d.totals[c] || 0), 0);
  const peak = Math.max(1, ...days.map(dayTotal), mode === 'ent' ? limitMs : 0);
  const stepMs = niceStep(peak);
  const top = Math.ceil(peak / stepMs) * stepMs;

  const bandW = plotW / Math.max(1, days.length);
  const barW = Math.min(24, Math.max(3, bandW - 4));
  const y = (ms) => padT + plotH - (ms / top) * plotH;

  host.replaceChildren();
  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });
  svg.setAttribute('aria-label', mode === 'ent' ? 'Entertainment time per day' : 'Time per day by category');
  addDefs(svg, t);

  // Gridlines: hairline, solid, recessive.
  for (let v = 0; v <= top + 1; v += stepMs) {
    const py = Math.round(y(v)) + 0.5;
    svg.appendChild(svgEl('line', {
      x1: padL, y1: py, x2: width - padR, y2: py,
      stroke: v === 0 ? t.lineStrong : t.line, 'stroke-width': 1,
    }));
    const label = svgEl('text', {
      x: padL - 7, y: py + 3, 'text-anchor': 'end', fill: t.text3, 'font-size': 10,
    });
    label.textContent = v === 0 ? '0' : `${Math.round(v / 3600000 * 10) / 10}h`;
    svg.appendChild(label);
  }

  // The one day that went furthest over gets a direct label; the rest stay clean.
  let worst = null;
  for (const d of days) {
    const over = (d.totals.ent || 0) - limitMs;
    if (limitMs > 0 && over > 0 && (!worst || over > worst.over)) worst = { key: d.key, over };
  }

  days.forEach((d, i) => {
    const x0 = padL + i * bandW + (bandW - barW) / 2;
    const parts = stackParts(d.totals, stackOrder, limitMs);
    parts.forEach((part, idx) => {
      const isTop = idx === parts.length - 1;
      const yTop = y(part.from + part.ms);
      const yBottom = y(part.from);
      // 2px surface gap between stacked segments, drawn by shortening the mark.
      const h = Math.max(1, yBottom - yTop - (idx > 0 ? 2 : 0));
      const over = part.c === 'over';
      const fill = over ? 'url(#tl-over)' : t[part.c];
      const node = isTop
        ? svgEl('path', { d: roundedTopPath(x0, yTop, barW, h, 4), fill })
        : svgEl('rect', { x: x0, y: yTop, width: barW, height: h, fill });
      if (over) {
        node.setAttribute('filter', 'url(#tl-glow)');
        svg.appendChild(node);
        // A hot cap line: the eye lands on where the day ended up, not just the colour.
        svg.appendChild(svgEl('rect', {
          x: x0, y: yTop, width: barW, height: Math.min(2, h), fill: t.overHot,
        }));
      } else {
        svg.appendChild(node);
      }
    });

    if (worst && worst.key === d.key) {
      // Keep the label inside the box: at the edges it hangs off the column instead.
      const mid = x0 + barW / 2;
      const nearRight = mid > width - padR - 42;
      const nearLeft = mid < padL + 42;
      const label = svgEl('text', {
        x: nearRight ? width - padR : nearLeft ? padL : mid,
        y: Math.max(padT + 9, y(dayTotal(d)) - 7),
        'text-anchor': nearRight ? 'end' : nearLeft ? 'start' : 'middle',
        fill: t.text2, 'font-size': 10, 'font-weight': 600,
        stroke: t.surface, 'stroke-width': 3, 'paint-order': 'stroke fill',
        'stroke-linejoin': 'round',
      });
      label.textContent = `+${fmtDuration(worst.over)} over`;
      svg.appendChild(label);
    }

    // Hit target covers the whole band, not just the mark.
    const hit = svgEl('rect', {
      x: padL + i * bandW, y: padT, width: bandW, height: plotH,
      fill: 'transparent', class: 'band', tabindex: 0, role: 'button',
    });
    const total = dayTotal(d);
    const over = limitMs > 0 ? (d.totals.ent || 0) - limitMs : 0;
    hit.setAttribute('aria-label',
      `${d.key}: ${fmtDuration(total)}${over > 0 ? `, ${fmtDuration(over)} over the limit` : ''}`);
    const lines = [
      { text: prettyDate(d.key), strong: true },
      ...stackOrder.map((c) => ({
        text: `${CLASS_LABEL[c]}: ${fmtDuration(d.totals[c] || 0)}`,
        swatch: t[c],
      })),
    ];
    if (over > 0) lines.push({ text: `Over the limit by ${fmtDuration(over)}`, swatch: t.over, strong: true });
    lines.push({ text: `Total: ${fmtDuration(total)}`, dim: true });
    hit.addEventListener('mousemove', (e) => showTip(e, lines));
    hit.addEventListener('mouseleave', hideTip);
    hit.addEventListener('click', () => onPick && onPick(d.key));
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick && onPick(d.key); }
    });
    svg.appendChild(hit);

    if (d.key === selectedKey) {
      svg.appendChild(svgEl('rect', {
        x: padL + i * bandW + 0.5, y: padT, width: bandW - 1, height: plotH,
        fill: 'none', stroke: t.lineStrong, 'stroke-width': 1,
      }));
    }

    // X labels stay sparse: roughly one per five columns, plus the last.
    if (i % 5 === 0 || i === days.length - 1) {
      const label = svgEl('text', {
        x: padL + i * bandW + bandW / 2, y: height - 8,
        'text-anchor': 'middle', fill: t.text3, 'font-size': 10,
      });
      label.textContent = shortDate(d.key);
      svg.appendChild(label);
    }
  });

  // Entertainment starts at the baseline in both views, so the line reads in both.
  if (limitMs > 0 && limitMs <= top) {
    const py = Math.round(y(limitMs)) + 0.5;
    svg.appendChild(svgEl('line', {
      x1: padL, y1: py, x2: width - padR, y2: py, stroke: t.text2, 'stroke-width': 1,
    }));
    // A halo in the surface colour keeps the label readable where a column runs under it.
    const label = svgEl('text', {
      x: padL + 4, y: py + 12, 'text-anchor': 'start', fill: t.text2, 'font-size': 10,
      stroke: t.surface, 'stroke-width': 4, 'paint-order': 'stroke fill',
      'stroke-linejoin': 'round',
    });
    label.textContent = `daily limit ${fmtDuration(limitMs)}`;
    svg.appendChild(label);
  }

  host.appendChild(svg);
}

function niceStep(peak) {
  const hours = peak / 3600000;
  const candidates = [0.25, 0.5, 1, 2, 3, 6, 12];
  for (const c of candidates) {
    if (hours / c <= 4.5) return c * 3600000;
  }
  return 24 * 3600000;
}

export function prettyDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

export function shortDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
