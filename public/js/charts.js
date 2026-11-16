const SVG_NS = 'http://www.w3.org/2000/svg';
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let uidCounter = 0;
let tooltipEl = null;
let activeAnchor = null;
let listenersBound = false;

function nextId(prefix) {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function sanitizeColor(color, fallback = '#ff5a36') {
  if (typeof color !== 'string') return fallback;
  const trimmed = color.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed;
  if (/^(rgb|rgba|hsl|hsla)\(\s*[\d.,%\s/+-]+\)$/.test(trimmed)) return trimmed;
  if (/^var\(--[a-zA-Z0-9_-]+\)$/.test(trimmed)) return trimmed;
  return fallback;
}

function toFiniteNumber(val) {
  if (typeof val === 'boolean' || val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function parseLocalDate(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null;
  }
  return d;
}

function formatShortDate(dateStr) {
  const d = parseLocalDate(dateStr);
  if (!d) return String(dateStr || '');
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

function formatLongDate(dateStr) {
  const d = parseLocalDate(dateStr);
  if (!d) return String(dateStr || '');
  return `${WEEKDAYS_SHORT[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatDuration(sec) {
  const n = toFiniteNumber(sec);
  if (n === null) return '';
  const rounded = Math.max(0, Math.round(n));
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatCompactNumber(val, { compactLarge = false } = {}) {
  const n = toFiniteNumber(val);
  if (n === null) return '';
  if (compactLarge && Math.abs(n) >= 10000) {
    const k = n / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  if (Number.isInteger(n)) {
    return n.toLocaleString();
  }
  const fixed = Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2);
  return String(Number(fixed));
}

function formatMetric(val, metricFormat = 'number', { compactLarge = false } = {}) {
  const n = toFiniteNumber(val);
  if (n === null) return '';
  if (metricFormat === 'duration_sec') return formatDuration(n);
  if (metricFormat === 'percent') return `${formatCompactNumber(n)}%`;
  if (metricFormat === 'currency') {
    const sign = n < 0 ? '-' : '';
    return `${sign}$${formatCompactNumber(Math.abs(n), { compactLarge })}`;
  }
  return formatCompactNumber(n, { compactLarge });
}

function truncateText(str, maxLen = 18) {
  const s = String(str ?? '');
  const chars = Array.from(s);
  if (chars.length <= maxLen) return s;
  return `${chars.slice(0, Math.max(1, maxLen - 1)).join('')}…`;
}

function ensureTooltip() {
  if (typeof document === 'undefined') return null;
  if (!tooltipEl || !document.body.contains(tooltipEl)) {
    tooltipEl = el('div', 'dg-tooltip');
    tooltipEl.setAttribute('role', 'tooltip');
    tooltipEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tooltipEl);
  }
  if (!listenersBound && typeof window !== 'undefined') {
    listenersBound = true;
    const dismiss = () => hideTooltip();
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') dismiss();
    });
  }
  return tooltipEl;
}

function positionTooltip(anchor) {
  if (!tooltipEl || !anchor || typeof window === 'undefined') return;
  const anchorRect = anchor.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();
  const pad = 8;
  const gap = 10;

  let left = anchorRect.left + anchorRect.width / 2 - tipRect.width / 2;
  left = Math.max(pad, Math.min(left, window.innerWidth - tipRect.width - pad));

  let top = anchorRect.top - tipRect.height - gap;
  if (top < pad) {
    top = anchorRect.bottom + gap;
  }
  if (top + tipRect.height > window.innerHeight - pad) {
    top = Math.max(pad, window.innerHeight - tipRect.height - pad);
  }

  tooltipEl.style.left = `${Math.round(left)}px`;
  tooltipEl.style.top = `${Math.round(top)}px`;
}

function showTooltip(anchor, buildContent) {
  const tip = ensureTooltip();
  if (!tip || !anchor) return;
  activeAnchor = anchor;
  tip.replaceChildren();
  buildContent(tip);
  tip.dataset.visible = 'true';
  tip.setAttribute('aria-hidden', 'false');
  positionTooltip(anchor);
}

function hideTooltip(forAnchor = null) {
  if (!tooltipEl) return;
  if (forAnchor && activeAnchor && forAnchor !== activeAnchor) return;
  activeAnchor = null;
  tooltipEl.dataset.visible = 'false';
  tooltipEl.setAttribute('aria-hidden', 'true');
}

function clearContainer(container) {
  if (!container) return false;
  if (activeAnchor && container.contains(activeAnchor)) {
    hideTooltip();
  }
  container.replaceChildren();
  return true;
}

function appendTooltipRow(tip, keyText, valText) {
  const row = el('div', 'dg-tip-row');
  row.appendChild(el('span', 'dg-tip-key', keyText));
  row.appendChild(el('span', 'dg-tip-val', valText));
  tip.appendChild(row);
  return row;
}

function renderEmptyState(container, message) {
  const box = el('div', 'dg-chart-empty');
  const icon = svgEl('svg', {
    class: 'dg-chart-empty-icon',
    width: 28,
    height: 28,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.75,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  icon.appendChild(svgEl('path', { d: 'M3 3v18h18' }));
  icon.appendChild(svgEl('path', { d: 'M7 15l4-4 4 3 5-6' }));
  box.appendChild(icon);
  box.appendChild(el('div', null, message));
  container.appendChild(box);
}

function computeNiceScale(rawMin, rawMax, metricFormat = 'number', targetTicks = 5) {
  let min = rawMin;
  let max = rawMax;

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 10, ticks: [0, 2.5, 5, 7.5, 10] };
  }

  if (min === max) {
    if (metricFormat === 'fraction' && min >= 1 && min <= 10) {
      min = 1;
      max = Math.max(6, Math.ceil(rawMax));
    } else if (metricFormat === 'percent') {
      min = Math.max(0, Math.floor((min - 10) / 10) * 10);
      max = Math.min(100, Math.ceil((max + 10) / 10) * 10);
      if (min === max) {
        min = 0;
        max = 100;
      }
    } else if (min === 0) {
      min = 0;
      max = metricFormat === 'duration_sec' ? 60 : 10;
    } else {
      const pad = Math.max(1, Math.abs(min) * 0.2);
      min = min >= 0 ? Math.max(0, min - pad) : min - pad;
      max = max + pad;
    }
  } else {
    const span = max - min;
    const pad = span * 0.08;
    min = min >= 0 ? Math.max(0, min - pad) : min - pad;
    max = max + pad;
    if (metricFormat === 'percent' && rawMin >= 0 && rawMax <= 100) {
      min = Math.max(0, min);
      max = Math.min(100, max);
    }
  }

  if (metricFormat === 'duration_sec') {
    const niceDurationSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
    const roughStep = (max - min) / Math.max(2, targetTicks - 1);
    let step = niceDurationSteps.find((s) => s >= roughStep);
    if (!step) {
      step = Math.ceil(roughStep / 3600) * 3600;
    }
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = niceMin; v <= niceMax + step * 0.001; v += step) {
      ticks.push(Math.round(v));
    }
    return { min: niceMin, max: niceMax, ticks };
  }

  const range = Math.max(1e-9, max - min);
  const roughStep = range / Math.max(2, targetTicks - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const norm = roughStep / mag;
  let stepFactor = 10;
  if (norm <= 1) stepFactor = 1;
  else if (norm <= 2) stepFactor = 2;
  else if (norm <= 2.5 && mag >= 10) stepFactor = 2.5;
  else if (norm <= 5) stepFactor = 5;

  let step = stepFactor * mag;
  if (metricFormat === 'fraction') {
    if (rawMax - rawMin <= 6 && rawMin >= 0 && rawMax <= 10) {
      step = 1;
    } else if (step < 1) {
      step = 1;
    }
  }

  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  const count = Math.round((niceMax - niceMin) / step);
  for (let i = 0; i <= count; i++) {
    const val = Number((niceMin + i * step).toFixed(6));
    ticks.push(val);
  }
  return { min: niceMin, max: niceMax, ticks };
}

function createStarPolygon(cx, cy, outerR, innerR) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(cx + r * Math.cos(angle)).toFixed(2)},${(cy + r * Math.sin(angle)).toFixed(2)}`);
  }
  return pts.join(' ');
}

function bindInteractiveEvents(target, { onEnter, onLeave, onActivate } = {}) {
  target.addEventListener('mouseenter', () => onEnter?.());
  target.addEventListener('mouseleave', () => onLeave?.());
  target.addEventListener('focus', () => onEnter?.());
  target.addEventListener('blur', () => onLeave?.());
  if (onActivate) {
    target.addEventListener('click', () => onActivate());
    target.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    });
  }
}

/**
 * 1. Trend Line Chart with Rolling Average, PB Stars, Null/DNF markers & Y-Axis Inversion
 */
export function renderTrendChart(
  container,
  {
    points = [],
    metricFormat = 'number',
    metricDirection = 'higher_is_better',
    metricLabel = 'Score',
    accentColor = '#ff5a36',
    onSelectPoint = null,
  } = {}
) {
  if (!clearContainer(container)) return;
  const list = Array.isArray(points) ? points : [];
  if (list.length === 0) {
    renderEmptyState(container, 'No entries recorded in this range yet. Log a play to see your score trend.');
    return;
  }

  const accent = sanitizeColor(accentColor);
  const lowerIsBetter = metricDirection === 'lower_is_better';

  const normalized = list.map((pt, idx) => {
    const rawVal = pt?.value !== undefined ? pt.value : pt?.primaryValue;
    const numVal = toFiniteNumber(rawVal);
    const numRoll = toFiniteNumber(pt?.rollingAvg);
    const rawDiff = pt?.difficulty;
    let difficulty = null;
    if (typeof rawDiff === 'string' && rawDiff.trim()) {
      difficulty = rawDiff.trim();
    } else if (
      rawDiff &&
      typeof rawDiff === 'object' &&
      typeof rawDiff.label === 'string' &&
      rawDiff.label.trim()
    ) {
      difficulty = rawDiff.label.trim();
    } else if (typeof pt?.difficultyLabel === 'string' && pt.difficultyLabel.trim()) {
      difficulty = pt.difficultyLabel.trim();
    }
    return {
      raw: pt,
      idx,
      playDate: pt?.playDate ?? '',
      value: numVal,
      displayValue: pt?.displayValue ?? null,
      rollingAvg: numRoll,
      rollingAvgDisplay: pt?.rollingAvgDisplay ?? null,
      solved: pt?.solved ?? null,
      puzzleId: pt?.puzzleId ?? null,
      difficulty,
      isPersonalBest: Boolean(pt?.isPersonalBest),
      rawSnippet: pt?.rawSnippet ?? '',
    };
  });

  const numericValues = [];
  let hasRollingAvg = false;
  let hasPersonalBest = false;
  let hasNullPoint = false;

  for (const p of normalized) {
    if (p.value !== null) numericValues.push(p.value);
    else hasNullPoint = true;
    if (p.rollingAvg !== null) {
      numericValues.push(p.rollingAvg);
      hasRollingAvg = true;
    }
    if (p.isPersonalBest) hasPersonalBest = true;
  }

  const wrap = el('div', 'dg-chart-wrap');

  // Header & Legend
  const header = el('div', 'dg-chart-header');
  const meta = el('div', 'dg-chart-meta');
  meta.appendChild(el('strong', null, metricLabel || 'Score'));
  const dirLabel = lowerIsBetter
    ? '↓ Lower is better (plotted higher)'
    : '↑ Higher is better';
  meta.appendChild(el('span', 'dg-chart-dir-badge', dirLabel));
  header.appendChild(meta);

  const legend = el('div', 'dg-chart-legend');
  const primaryItem = el('span', 'dg-legend-item');
  const primarySwatch = el('span', 'dg-legend-swatch');
  primarySwatch.style.background = accent;
  primaryItem.appendChild(primarySwatch);
  primaryItem.appendChild(el('span', null, metricLabel || 'Score'));
  legend.appendChild(primaryItem);

  if (hasRollingAvg) {
    const rollItem = el('span', 'dg-legend-item');
    rollItem.appendChild(el('span', 'dg-legend-line'));
    rollItem.appendChild(el('span', null, 'Rolling Avg'));
    legend.appendChild(rollItem);
  }
  if (hasPersonalBest) {
    const pbItem = el('span', 'dg-legend-item');
    pbItem.appendChild(el('span', 'dg-legend-star', '★'));
    pbItem.appendChild(el('span', null, 'Personal Best'));
    legend.appendChild(pbItem);
  }
  if (hasNullPoint) {
    const nullItem = el('span', 'dg-legend-item');
    nullItem.appendChild(el('span', 'dg-legend-hollow'));
    nullItem.appendChild(el('span', null, 'Played / DNF'));
    legend.appendChild(nullItem);
  }

  header.appendChild(legend);
  wrap.appendChild(header);

  // Geometry
  const W = 720;
  const H = 290;
  const margin = { top: 24, right: 24, bottom: 38, left: 62 };
  const plotLeft = margin.left;
  const plotRight = W - margin.right;
  const plotTop = margin.top;
  const plotBottom = H - margin.bottom;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  const svg = svgEl('svg', {
    class: 'dg-chart-svg',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': `${metricLabel || 'Score'} trend chart`,
  });

  const gradId = nextId('dg-trend-grad');
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': accent, 'stop-opacity': '0.28' }));
  grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': accent, 'stop-opacity': '0.01' }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  const hasNumeric = numericValues.length > 0;
  const scale = hasNumeric
    ? computeNiceScale(Math.min(...numericValues), Math.max(...numericValues), metricFormat, 5)
    : { min: 0, max: 1, ticks: [] };

  const domainSpan = Math.max(1e-9, scale.max - scale.min);
  const mapX = (i) => {
    if (normalized.length === 1) return plotLeft + plotW / 2;
    return plotLeft + (i / (normalized.length - 1)) * plotW;
  };
  const mapY = (val) => {
    const norm = (val - scale.min) / domainSpan;
    const t = lowerIsBetter ? 1 - norm : norm;
    return plotBottom - t * plotH;
  };

  // Gridlines & Y-Axis ticks
  if (hasNumeric) {
    for (const tick of scale.ticks) {
      const y = mapY(tick);
      svg.appendChild(
        svgEl('line', {
          class: 'dg-gridline',
          x1: plotLeft,
          y1: y,
          x2: plotRight,
          y2: y,
        })
      );
      svg.appendChild(
        svgEl(
          'text',
          {
            class: 'dg-axis-text',
            x: plotLeft - 10,
            y: y + 4,
            'text-anchor': 'end',
          },
          formatMetric(tick, metricFormat, { compactLarge: true })
        )
      );
    }
  } else {
    svg.appendChild(
      svgEl('line', {
        class: 'dg-gridline',
        x1: plotLeft,
        y1: plotBottom - 16,
        x2: plotRight,
        y2: plotBottom - 16,
      })
    );
  }

  // Baseline axis
  svg.appendChild(
    svgEl('line', {
      class: 'dg-axis-line',
      x1: plotLeft,
      y1: plotBottom,
      x2: plotRight,
      y2: plotBottom,
    })
  );

  // X-axis date labels (evenly spaced, avoiding collision)
  const labelIndices = new Set();
  if (normalized.length <= 6) {
    normalized.forEach((_, idx) => labelIndices.add(idx));
  } else {
    const targetLabels = 6;
    for (let k = 0; k < targetLabels; k++) {
      labelIndices.add(Math.round((k * (normalized.length - 1)) / (targetLabels - 1)));
    }
  }
  for (const idx of labelIndices) {
    const x = mapX(idx);
    const anchor =
      normalized.length > 1 && idx === 0
        ? 'start'
        : normalized.length > 1 && idx === normalized.length - 1
          ? 'end'
          : 'middle';
    svg.appendChild(
      svgEl(
        'text',
        {
          class: 'dg-axis-text',
          x,
          y: plotBottom + 20,
          'text-anchor': anchor,
        },
        formatShortDate(normalized[idx].playDate)
      )
    );
  }

  // Crosshair line
  const crosshair = svgEl('line', {
    class: 'dg-trend-crosshair',
    x1: plotLeft,
    y1: plotTop,
    x2: plotLeft,
    y2: plotBottom,
  });
  svg.appendChild(crosshair);

  // Build contiguous segments for primary line & area fill (breaking on value === null)
  if (hasNumeric) {
    const segments = [];
    let current = [];
    for (const p of normalized) {
      if (p.value !== null) {
        current.push({ x: mapX(p.idx), y: mapY(p.value) });
      } else if (current.length > 0) {
        segments.push(current);
        current = [];
      }
    }
    if (current.length > 0) segments.push(current);

    for (const seg of segments) {
      if (seg.length >= 2) {
        const lineD = seg
          .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`)
          .join(' ');
        const areaD = `${lineD} L ${seg[seg.length - 1].x.toFixed(2)} ${plotBottom.toFixed(2)} L ${seg[0].x.toFixed(2)} ${plotBottom.toFixed(2)} Z`;
        svg.appendChild(svgEl('path', { d: areaD, fill: `url(#${gradId})`, 'pointer-events': 'none' }));
        svg.appendChild(svgEl('path', { class: 'dg-trend-path', d: lineD, stroke: accent }));
      }
    }

    // Rolling average dashed segments
    const rollSegments = [];
    let rollCur = [];
    for (const p of normalized) {
      if (p.rollingAvg !== null) {
        rollCur.push({ x: mapX(p.idx), y: mapY(p.rollingAvg) });
      } else if (rollCur.length > 0) {
        rollSegments.push(rollCur);
        rollCur = [];
      }
    }
    if (rollCur.length > 0) rollSegments.push(rollCur);

    for (const seg of rollSegments) {
      if (seg.length >= 2) {
        const d = seg
          .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`)
          .join(' ');
        svg.appendChild(svgEl('path', { class: 'dg-rolling-path', d }));
      }
    }
  }

  // Interactive Points
  const clickable = typeof onSelectPoint === 'function';
  const nullBaselineY = hasNumeric ? plotBottom - 9 : plotBottom - 16;

  for (const p of normalized) {
    const cx = mapX(p.idx);
    const isNull = p.value === null;
    const cy = isNull ? nullBaselineY : mapY(p.value);
    const isDnf = p.solved === false;

    const group = svgEl('g');

    if (p.isPersonalBest && !isNull) {
      group.appendChild(
        svgEl('circle', {
          class: 'dg-point-pb-ring',
          cx,
          cy,
          r: 8.5,
        })
      );
      const starY = Math.max(8, cy - 13);
      group.appendChild(
        svgEl('polygon', {
          class: 'dg-point-pb-star',
          points: createStarPolygon(cx, starY, 5.5, 2.4),
        })
      );
    }

    const scoreSummary = isNull
      ? isDnf
        ? 'DNF'
        : 'Played (no score)'
      : p.displayValue || formatMetric(p.value, metricFormat);

    const hit = svgEl('circle', {
      class: `dg-hit-target${clickable ? ' is-clickable' : ''}`,
      cx,
      cy,
      r: 13,
      tabindex: 0,
      role: clickable ? 'button' : 'img',
      'aria-label': `${p.playDate}${p.puzzleId ? ` ${p.puzzleId}` : ''}${p.difficulty ? ` (${p.difficulty})` : ''}: ${scoreSummary}`,
    });
    group.appendChild(hit);

    if (isNull) {
      const marker = svgEl('circle', {
        class: isDnf ? 'dg-point-dnf' : 'dg-point-null',
        cx,
        cy,
        r: 4.3,
      });
      group.appendChild(marker);
      if (isDnf) {
        group.appendChild(
          svgEl('path', {
            d: `M ${cx - 2.2} ${cy - 2.2} L ${cx + 2.2} ${cy + 2.2} M ${cx + 2.2} ${cy - 2.2} L ${cx - 2.2} ${cy + 2.2}`,
            stroke: 'var(--danger, #e53555)',
            'stroke-width': 1.5,
            'stroke-linecap': 'round',
            'pointer-events': 'none',
          })
        );
      }
    } else {
      const dot = svgEl('circle', {
        class: 'dg-point-dot',
        cx,
        cy,
        r: p.isPersonalBest ? 5 : 4.2,
        fill: isDnf ? 'var(--surface-2, #efe7d4)' : accent,
        stroke: isDnf ? 'var(--danger, #e53555)' : 'var(--surface-2, #efe7d4)',
        'stroke-width': isDnf ? 2.2 : 1.8,
      });
      group.appendChild(dot);
    }

    bindInteractiveEvents(hit, {
      onEnter: () => {
        crosshair.setAttribute('x1', cx);
        crosshair.setAttribute('x2', cx);
        crosshair.classList.add('is-active');
        showTooltip(hit, (tip) => {
          const title = el('div', 'dg-tip-title');
          title.appendChild(el('span', null, formatLongDate(p.playDate) || p.playDate));
          if (p.puzzleId) {
            title.appendChild(el('span', 'dg-tip-sub', p.puzzleId));
          }
          tip.appendChild(title);

          appendTooltipRow(tip, metricLabel || 'Score', scoreSummary);

          if (p.difficulty) {
            appendTooltipRow(tip, 'Difficulty', p.difficulty);
          }

          if (p.rollingAvg !== null) {
            const rollStr = p.rollingAvgDisplay || formatMetric(p.rollingAvg, metricFormat);
            appendTooltipRow(tip, 'Rolling Avg', rollStr);
          }

          if (p.isPersonalBest || p.solved !== null) {
            const badges = el('div', 'dg-tip-row');
            badges.style.justifyContent = 'flex-start';
            badges.style.gap = '6px';
            badges.style.marginTop = '5px';
            if (p.isPersonalBest) {
              badges.appendChild(el('span', 'dg-tip-badge is-pb', '★ Personal Best'));
            }
            if (p.solved === true) {
              badges.appendChild(el('span', 'dg-tip-badge is-solved', 'Solved'));
            } else if (p.solved === false) {
              badges.appendChild(el('span', 'dg-tip-badge is-dnf', 'DNF'));
            }
            tip.appendChild(badges);
          }

          if (p.rawSnippet) {
            tip.appendChild(el('div', 'dg-tip-snippet', truncateText(p.rawSnippet, 140)));
          }
        });
      },
      onLeave: () => {
        crosshair.classList.remove('is-active');
        hideTooltip(hit);
      },
      onActivate: clickable ? () => onSelectPoint(p.raw) : null,
    });

    svg.appendChild(group);
  }

  wrap.appendChild(svg);

  if (!hasNumeric) {
    wrap.appendChild(
      el('div', 'dg-chart-note', 'No numeric scores logged yet in this range — showing play and DNF markers.')
    );
  } else if (numericValues.length === 1 && list.length === 1) {
    wrap.appendChild(
      el('div', 'dg-chart-note', 'Log one more session to start drawing your trend line and rolling average.')
    );
  }

  container.appendChild(wrap);
}

/**
 * 2. Score Distribution Horizontal Bar Chart
 */
export function renderDistributionChart(
  container,
  { buckets = [], metricFormat = 'number', accentColor = '#ff5a36' } = {}
) {
  if (!clearContainer(container)) return;
  const list = Array.isArray(buckets) ? buckets : [];
  const totalCount = list.reduce((sum, b) => sum + (Number(b?.count) || 0), 0);
  if (list.length === 0 || totalCount === 0) {
    renderEmptyState(container, 'No score distribution data available yet.');
    return;
  }

  const accent = sanitizeColor(accentColor);
  const maxCount = Math.max(1, ...list.map((b) => Number(b?.count) || 0));
  const scale = computeNiceScale(0, maxCount, 'fraction', 4);
  const scaleMax = Math.max(1, scale.max);

  const W = 680;
  const rowH = 36;
  const barH = 22;
  const margin = { top: 14, right: 94, bottom: 28, left: 118 };
  const H = Math.max(150, margin.top + list.length * rowH + margin.bottom);
  const plotLeft = margin.left;
  const plotRight = W - margin.right;
  const plotW = plotRight - plotLeft;
  const plotBottom = margin.top + list.length * rowH;

  const wrap = el('div', 'dg-chart-wrap');
  const svg = svgEl('svg', {
    class: 'dg-chart-svg',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': 'Score distribution bar chart',
  });

  // Vertical count gridlines
  for (const tick of scale.ticks) {
    if (!Number.isInteger(tick)) continue;
    const x = plotLeft + (tick / scaleMax) * plotW;
    svg.appendChild(
      svgEl('line', {
        class: 'dg-gridline',
        x1: x,
        y1: margin.top,
        x2: x,
        y2: plotBottom,
      })
    );
    svg.appendChild(
      svgEl(
        'text',
        {
          class: 'dg-axis-text',
          x,
          y: plotBottom + 18,
          'text-anchor': 'middle',
        },
        String(tick)
      )
    );
  }

  list.forEach((b, idx) => {
    const count = Math.max(0, Number(b?.count) || 0);
    const pct = toFiniteNumber(b?.percentage) ?? (totalCount > 0 ? (count / totalCount) * 100 : 0);
    const pctText = `${Number(pct.toFixed(1))}%`;
    const labelText = String(b?.label ?? '');

    const rowTop = margin.top + idx * rowH;
    const barY = rowTop + (rowH - barH) / 2;
    const barW = Math.max(count > 0 ? 4 : 0, (count / scaleMax) * plotW);
    const isPeak = count === maxCount && count > 0;

    const group = svgEl('g', { class: 'dg-bar-group' });

    group.appendChild(
      svgEl(
        'text',
        {
          class: 'dg-label-text',
          x: plotLeft - 10,
          y: rowTop + rowH / 2 + 4,
          'text-anchor': 'end',
        },
        truncateText(labelText, 15)
      )
    );

    group.appendChild(
      svgEl('rect', {
        class: 'dg-bar-track',
        x: plotLeft,
        y: barY,
        width: plotW,
        height: barH,
        rx: 6,
      })
    );

    if (barW > 0) {
      group.appendChild(
        svgEl('rect', {
          class: 'dg-bar-fill',
          x: plotLeft,
          y: barY,
          width: barW,
          height: barH,
          rx: 6,
          fill: accent,
          opacity: isPeak ? '1' : '0.76',
        })
      );
    }

    group.appendChild(
      svgEl(
        'text',
        {
          class: 'dg-value-text',
          x: plotRight + 10,
          y: rowTop + rowH / 2 + 4,
          'text-anchor': 'start',
        },
        `${count} (${pctText})`
      )
    );

    const hit = svgEl('rect', {
      class: 'dg-row-hit',
      x: 0,
      y: rowTop,
      width: W,
      height: rowH,
      rx: 6,
      tabindex: 0,
      role: 'img',
      'aria-label': `${labelText}: ${count} plays (${pctText})`,
    });
    group.appendChild(hit);

    bindInteractiveEvents(hit, {
      onEnter: () => {
        showTooltip(hit, (tip) => {
          const title = el('div', 'dg-tip-title');
          title.appendChild(el('span', null, labelText || 'Bucket'));
          tip.appendChild(title);

          const minN = toFiniteNumber(b?.min);
          const maxN = toFiniteNumber(b?.max);
          if (minN !== null && maxN !== null) {
            const minStr = formatMetric(minN, metricFormat);
            const maxStr = formatMetric(maxN, metricFormat);
            const rangeStr = minStr === maxStr ? minStr : `${minStr} – ${maxStr}`;
            if (rangeStr !== labelText) {
              appendTooltipRow(tip, 'Range', rangeStr);
            }
          }
          appendTooltipRow(tip, 'Plays', String(count));
          appendTooltipRow(tip, 'Share', pctText);
        });
      },
      onLeave: () => hideTooltip(hit),
    });

    svg.appendChild(group);
  });

  wrap.appendChild(svg);
  container.appendChild(wrap);
}

/**
 * 3. Sub-Round / Category / Difficulty Breakdown Chart
 */
export function renderBreakdownChart(
  container,
  {
    breakdownSummary = [],
    latestDate = null,
    accentColor = '#ff5a36',
    headerTitle = 'Sub-round Breakdown',
    subtitle = null,
    metricFormat = 'number',
    emptyMessage = 'No sub-round breakdown available for this parser yet',
  } = {}
) {
  if (!clearContainer(container)) return;
  const safeEmpty =
    typeof emptyMessage === 'string' && emptyMessage.trim()
      ? emptyMessage.trim()
      : 'No sub-round breakdown available for this parser yet';
  const safeTitle =
    typeof headerTitle === 'string' && headerTitle.trim()
      ? headerTitle.trim()
      : 'Sub-round Breakdown';
  const resolvedSubtitle =
    typeof subtitle === 'string' && subtitle.trim()
      ? subtitle.trim()
      : latestDate
        ? `Latest: ${latestDate}`
        : 'All sessions';

  const list = Array.isArray(breakdownSummary) ? breakdownSummary : [];
  if (list.length === 0) {
    renderEmptyState(container, safeEmpty);
    return;
  }

  const accent = sanitizeColor(accentColor);
  const isRichMode = list.some(
    (item) =>
      item &&
      (item.average !== undefined ||
        item.best !== undefined ||
        item.color !== undefined ||
        item.key !== undefined)
  );

  const items = list.map((item) => {
    const avgCandidate = item?.average !== undefined ? item.average : item?.avgValue;
    const latestCandidate = item?.latest !== undefined ? item.latest : item?.latestValue;
    return {
      key: item?.key ?? null,
      label: String(item?.label ?? item?.key ?? ''),
      avgValue: toFiniteNumber(avgCandidate),
      latestValue: toFiniteNumber(latestCandidate),
      bestValue: toFiniteNumber(item?.best !== undefined ? item.best : item?.bestValue),
      max: toFiniteNumber(item?.max),
      count: Math.max(0, Number(item?.count) || 0),
      color: item?.color ? sanitizeColor(item.color, accent) : null,
    };
  });

  const hasAnyNumeric = items.some(
    (i) => i.avgValue !== null || (!isRichMode && i.latestValue !== null)
  );
  if (!hasAnyNumeric) {
    renderEmptyState(container, safeEmpty);
    return;
  }

  const positiveMaxes = items.map((i) => i.max).filter((m) => m !== null && m > 0);
  const allShareSameMax =
    !isRichMode &&
    positiveMaxes.length === items.length &&
    positiveMaxes.every((m) => m === positiveMaxes[0]);
  const hasMixedMaxes = !isRichMode && positiveMaxes.length > 0 && !allShareSameMax;

  let sharedMax = 1;
  let ticks = [];
  if (!hasMixedMaxes) {
    const vals = [];
    for (const i of items) {
      if (i.avgValue !== null) vals.push(i.avgValue);
      if (!isRichMode && i.latestValue !== null) vals.push(i.latestValue);
      if (i.max !== null && i.max > 0) vals.push(i.max);
    }
    const maxVal = vals.length > 0 ? Math.max(...vals) : 0;
    const rawMax = metricFormat === 'duration_sec' ? maxVal : Math.max(1, maxVal);
    if (allShareSameMax && rawMax <= positiveMaxes[0]) {
      sharedMax = positiveMaxes[0];
      ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Number((sharedMax * f).toFixed(2)));
    } else {
      const s = computeNiceScale(0, rawMax, metricFormat, 5);
      sharedMax = Math.max(1, s.max);
      ticks = s.ticks;
    }
  }

  const wrap = el('div', 'dg-chart-wrap');

  // Header & Legend
  const header = el('div', 'dg-chart-header');
  const meta = el('div', 'dg-chart-meta');
  meta.appendChild(el('strong', null, safeTitle));
  meta.appendChild(el('span', 'dg-chart-dir-badge', resolvedSubtitle));
  header.appendChild(meta);

  const legend = el('div', 'dg-chart-legend');
  if (isRichMode) {
    const avgLegend = el('span', 'dg-legend-item');
    if (!items.some((i) => i.color)) {
      const swatch = el('span', 'dg-legend-swatch');
      swatch.style.background = accent;
      avgLegend.appendChild(swatch);
    }
    avgLegend.appendChild(
      el('span', null, metricFormat === 'duration_sec' ? 'Bar = Avg solve time' : 'Bar = Average')
    );
    legend.appendChild(avgLegend);
  } else {
    const latestLegend = el('span', 'dg-legend-item');
    const latestSwatch = el('span', 'dg-legend-swatch');
    latestSwatch.style.background = accent;
    latestLegend.appendChild(latestSwatch);
    latestLegend.appendChild(el('span', null, latestDate ? `Latest (${latestDate})` : 'Latest'));
    legend.appendChild(latestLegend);

    const avgLegend = el('span', 'dg-legend-item');
    const avgSwatch = el('span', 'dg-legend-swatch');
    avgSwatch.style.background = 'var(--muted, #786d65)';
    avgSwatch.style.opacity = '0.65';
    avgLegend.appendChild(avgSwatch);
    avgLegend.appendChild(el('span', null, 'Average'));
    legend.appendChild(avgLegend);
  }

  header.appendChild(legend);
  wrap.appendChild(header);

  const W = 680;
  const rowH = isRichMode ? 38 : 44;
  const margin = {
    top: 10,
    right: isRichMode ? 148 : 140,
    bottom: hasMixedMaxes ? 12 : 28,
    left: 124,
  };
  const H = Math.max(140, margin.top + items.length * rowH + margin.bottom);
  const plotLeft = margin.left;
  const plotRight = W - margin.right;
  const plotW = plotRight - plotLeft;
  const plotBottom = margin.top + items.length * rowH;

  const svg = svgEl('svg', {
    class: 'dg-chart-svg',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': safeTitle,
  });

  if (!hasMixedMaxes) {
    for (const tick of ticks) {
      const x = plotLeft + (tick / sharedMax) * plotW;
      svg.appendChild(
        svgEl('line', {
          class: 'dg-gridline',
          x1: x,
          y1: margin.top,
          x2: x,
          y2: plotBottom,
        })
      );
      svg.appendChild(
        svgEl(
          'text',
          {
            class: 'dg-axis-text',
            x,
            y: plotBottom + 18,
            'text-anchor': 'middle',
          },
          formatMetric(tick, metricFormat, { compactLarge: true })
        )
      );
    }
  }

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const rowTop = margin.top + idx * rowH;
    const rowMax = hasMixedMaxes
      ? Math.max(1, item.max ?? 0, item.avgValue ?? 0, item.latestValue ?? 0)
      : sharedMax;
    const barColor = item.color || accent;

    const group = svgEl('g', { class: 'dg-bar-group' });

    group.appendChild(
      svgEl(
        'text',
        {
          class: 'dg-label-text',
          x: plotLeft - 10,
          y: rowTop + rowH / 2 + 4,
          'text-anchor': 'end',
        },
        truncateText(item.label, 16)
      )
    );

    const avgStr = item.avgValue !== null ? formatMetric(item.avgValue, metricFormat) : '—';
    const latestStr = item.latestValue !== null ? formatMetric(item.latestValue, metricFormat) : '—';
    const bestStr = item.bestValue !== null ? formatMetric(item.bestValue, metricFormat) : '—';
    const maxSuffix = item.max ? ` / ${formatMetric(item.max, metricFormat)}` : '';
    const countLabel = `${item.count} ${item.count === 1 ? 'play' : 'plays'}`;

    if (isRichMode) {
      const barH = 20;
      const barY = rowTop + (rowH - barH) / 2;

      group.appendChild(
        svgEl('rect', {
          class: 'dg-bar-track',
          x: plotLeft,
          y: barY,
          width: plotW,
          height: barH,
          rx: 5,
        })
      );

      if (item.avgValue !== null) {
        const w = Math.max(
          item.avgValue > 0 ? 4 : 0,
          Math.min(plotW, (item.avgValue / rowMax) * plotW)
        );
        if (w > 0) {
          group.appendChild(
            svgEl('rect', {
              class: 'dg-bar-fill',
              x: plotLeft,
              y: barY,
              width: w,
              height: barH,
              rx: 5,
              fill: barColor,
              opacity: item.color ? '0.92' : '1',
            })
          );
        }
      }

      const rightText = item.count > 0 ? `${avgStr} · ${countLabel}` : avgStr;
      group.appendChild(
        svgEl(
          'text',
          {
            class: 'dg-value-text',
            x: plotRight + 10,
            y: rowTop + rowH / 2 + 4,
            'text-anchor': 'start',
          },
          rightText
        )
      );
    } else {
      const latestY = rowTop + 9;
      const avgY = rowTop + 24;
      const latestH = 11;
      const avgH = 9;

      // Background tracks
      group.appendChild(
        svgEl('rect', {
          class: 'dg-bar-track',
          x: plotLeft,
          y: latestY,
          width: plotW,
          height: latestH,
          rx: 4,
        })
      );
      group.appendChild(
        svgEl('rect', {
          class: 'dg-bar-track',
          x: plotLeft,
          y: avgY,
          width: plotW,
          height: avgH,
          rx: 4,
        })
      );

      if (item.latestValue !== null) {
        const w = Math.max(
          item.latestValue > 0 ? 4 : 0,
          Math.min(plotW, (item.latestValue / rowMax) * plotW)
        );
        if (w > 0) {
          group.appendChild(
            svgEl('rect', {
              class: 'dg-bar-fill',
              x: plotLeft,
              y: latestY,
              width: w,
              height: latestH,
              rx: 4,
              fill: barColor,
            })
          );
        }
      }

      if (item.avgValue !== null) {
        const w = Math.max(
          item.avgValue > 0 ? 4 : 0,
          Math.min(plotW, (item.avgValue / rowMax) * plotW)
        );
        if (w > 0) {
          group.appendChild(
            svgEl('rect', {
              class: 'dg-bar-avg',
              x: plotLeft,
              y: avgY,
              width: w,
              height: avgH,
              rx: 4,
            })
          );
        }
      }

      group.appendChild(
        svgEl(
          'text',
          {
            class: 'dg-value-text',
            x: plotRight + 10,
            y: rowTop + rowH / 2 + 4,
            'text-anchor': 'start',
          },
          `${latestStr} · avg ${avgStr}`
        )
      );
    }

    const hit = svgEl('rect', {
      class: 'dg-row-hit',
      x: 0,
      y: rowTop,
      width: W,
      height: rowH,
      rx: 6,
      tabindex: 0,
      role: 'img',
      'aria-label': isRichMode
        ? `${item.label}: Average ${avgStr}, ${countLabel}`
        : `${item.label}: Latest ${latestStr}, Average ${avgStr}`,
    });
    group.appendChild(hit);

    bindInteractiveEvents(hit, {
      onEnter: () => {
        showTooltip(hit, (tip) => {
          const title = el('div', 'dg-tip-title');
          title.appendChild(el('span', null, item.label));
          if (item.count > 0) {
            title.appendChild(el('span', 'dg-tip-sub', countLabel));
          }
          tip.appendChild(title);

          if (isRichMode) {
            appendTooltipRow(
              tip,
              'Avg',
              item.avgValue !== null ? `${avgStr}${maxSuffix}` : '—'
            );
            if (item.latestValue !== null) {
              appendTooltipRow(tip, 'Latest', `${latestStr}${maxSuffix}`);
            }
            if (item.bestValue !== null) {
              appendTooltipRow(tip, 'Best', `${bestStr}${maxSuffix}`);
            }
            appendTooltipRow(tip, 'Plays', countLabel);
          } else {
            appendTooltipRow(
              tip,
              latestDate ? `Latest (${latestDate})` : 'Latest',
              item.latestValue !== null ? `${latestStr}${maxSuffix}` : '—'
            );
            appendTooltipRow(
              tip,
              'Average',
              item.avgValue !== null ? `${avgStr}${maxSuffix}` : '—'
            );
            if (item.bestValue !== null) {
              appendTooltipRow(tip, 'Best', `${bestStr}${maxSuffix}`);
            }
            appendTooltipRow(tip, 'Plays', countLabel);
          }
        });
      },
      onLeave: () => hideTooltip(hit),
    });

    svg.appendChild(group);
  }

  wrap.appendChild(svg);
  container.appendChild(wrap);
}

/**
 * 4. GitHub-style 13-week x 7-day Activity Heatmap
 */
export function renderActivityHeatmap(
  container,
  { days = [], selectedDate = null, onSelectDate = null } = {}
) {
  if (!clearContainer(container)) return;
  const list = Array.isArray(days) ? days : [];
  if (list.length === 0) {
    renderEmptyState(container, 'No activity history available yet.');
    return;
  }

  const parsedDays = list.map((d, idx) => {
    const localDate = parseLocalDate(d?.date);
    return {
      raw: d,
      idx,
      date: d?.date ?? '',
      localDate,
      count: Math.max(0, Number(d?.count) || 0),
      totalActive: Math.max(0, Number(d?.totalActive) || 0),
      games: Array.isArray(d?.games) ? d.games : [],
    };
  });

  const firstValid = parsedDays.find((d) => d.localDate !== null)?.localDate ?? null;
  const week0Sunday = firstValid
    ? new Date(firstValid.getFullYear(), firstValid.getMonth(), firstValid.getDate() - firstValid.getDay())
    : null;

  let maxCol = 0;
  for (const item of parsedDays) {
    if (week0Sunday && item.localDate) {
      const diffDays = Math.round((item.localDate - week0Sunday) / 86400000);
      item.col = Math.max(0, Math.floor(diffDays / 7));
      item.row = item.localDate.getDay();
    } else {
      item.col = Math.floor(item.idx / 7);
      item.row = item.idx % 7;
    }
    if (item.col > maxCol) maxCol = item.col;
  }

  const totalCols = maxCol + 1;
  const cellSize = 18;
  const gap = 5;
  const step = cellSize + gap;
  const leftPad = 36;
  const topPad = 24;
  const rightPad = 8;
  const bottomPad = 8;

  const svgW = leftPad + totalCols * step - gap + rightPad;
  const svgH = topPad + 7 * step - gap + bottomPad;

  const wrap = el('div', 'dg-chart-wrap');
  const scrollWrap = el('div', 'dg-heatmap-scroll');
  const svg = svgEl('svg', {
    class: 'dg-heatmap-svg',
    viewBox: `0 0 ${svgW} ${svgH}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'grid',
    'aria-label': '91-day game activity heatmap',
  });

  // Weekday labels (Mon, Wed, Fri)
  for (const rowIdx of [1, 3, 5]) {
    svg.appendChild(
      svgEl(
        'text',
        {
          class: 'dg-axis-text',
          x: leftPad - 8,
          y: topPad + rowIdx * step + cellSize / 2 + 4,
          'text-anchor': 'end',
        },
        WEEKDAYS_SHORT[rowIdx]
      )
    );
  }

  // Month labels above columns
  const monthMarkers = [];
  let prevMonth = -1;
  for (const item of parsedDays) {
    if (!item.localDate) continue;
    const m = item.localDate.getMonth();
    if (m !== prevMonth) {
      if (
        monthMarkers.length > 0 &&
        item.col - monthMarkers[monthMarkers.length - 1].col <= 1
      ) {
        monthMarkers[monthMarkers.length - 1] = { col: item.col, label: MONTHS_SHORT[m] };
      } else {
        monthMarkers.push({ col: item.col, label: MONTHS_SHORT[m] });
      }
      prevMonth = m;
    }
  }
  for (const mm of monthMarkers) {
    svg.appendChild(
      svgEl(
        'text',
        {
          class: 'dg-axis-text',
          x: leftPad + mm.col * step,
          y: topPad - 8,
          'text-anchor': 'start',
        },
        mm.label
      )
    );
  }

  const clickable = typeof onSelectDate === 'function';
  let totalPlays = 0;
  let activeDays = 0;
  let selectedCoords = null;

  for (const item of parsedDays) {
    if (item.count > 0) {
      totalPlays += item.count;
      activeDays += 1;
    }

    let level = 0;
    if (item.count > 0) {
      const ratio = item.count / Math.max(1, item.totalActive);
      if (ratio >= 1) level = 4;
      else if (ratio >= 0.6) level = 3;
      else if (ratio >= 0.3) level = 2;
      else level = 1;
    }

    const x = leftPad + item.col * step;
    const y = topPad + item.row * step;
    const isSelected = Boolean(selectedDate && item.date === selectedDate);
    if (isSelected) selectedCoords = { x, y };

    const cell = svgEl('rect', {
      class: `dg-hm-cell${clickable ? ' is-clickable' : ''}`,
      x,
      y,
      width: cellSize,
      height: cellSize,
      rx: 4,
      'data-level': level,
      tabindex: 0,
      role: clickable ? 'button' : 'gridcell',
      'aria-selected': isSelected ? 'true' : 'false',
      'aria-label': `${item.date}: ${item.count} of ${item.totalActive} games played`,
    });

    bindInteractiveEvents(cell, {
      onEnter: () => {
        showTooltip(cell, (tip) => {
          const isSweep = item.totalActive > 0 && item.count >= item.totalActive;
          const title = el('div', 'dg-tip-title');
          title.appendChild(el('span', null, formatLongDate(item.date) || item.date));
          if (isSweep) {
            title.appendChild(el('span', 'dg-tip-badge is-solved', 'Sweep'));
          }
          tip.appendChild(title);

          appendTooltipRow(
            tip,
            'Completed',
            `${item.count} / ${item.totalActive}`
          );

          if (item.games.length > 0) {
            const listWrap = el('div', 'dg-tip-games');
            const maxVisible = 8;
            const shown = item.games.slice(0, maxVisible);
            for (const g of shown) {
              const gRow = el('div', 'dg-tip-game-row');
              const left = el('span', null, `${g?.icon ? `${g.icon} ` : ''}${g?.name ?? ''}`);
              const right = el('strong', null, g?.displayValue ?? 'Played');
              gRow.appendChild(left);
              gRow.appendChild(right);
              listWrap.appendChild(gRow);
            }
            if (item.games.length > maxVisible) {
              listWrap.appendChild(
                el('div', 'dg-tip-sub', `+${item.games.length - maxVisible} more`)
              );
            }
            tip.appendChild(listWrap);
          } else {
            tip.appendChild(el('div', 'dg-tip-sub', 'No games logged'));
          }
        });
      },
      onLeave: () => hideTooltip(cell),
      onActivate: clickable ? () => onSelectDate(item.raw) : null,
    });

    svg.appendChild(cell);
  }

  if (selectedCoords) {
    svg.appendChild(
      svgEl('rect', {
        class: 'dg-hm-selected-ring',
        x: selectedCoords.x - 2,
        y: selectedCoords.y - 2,
        width: cellSize + 4,
        height: cellSize + 4,
        rx: 6,
      })
    );
  }

  scrollWrap.appendChild(svg);
  wrap.appendChild(scrollWrap);

  const footer = el('div', 'dg-hm-footer');
  footer.appendChild(
    el(
      'span',
      null,
      `${totalPlays} ${totalPlays === 1 ? 'play' : 'plays'} across ${activeDays} active ${activeDays === 1 ? 'day' : 'days'}`
    )
  );

  const legend = el('div', 'dg-hm-legend');
  legend.appendChild(el('span', null, 'Less'));
  for (let lvl = 0; lvl <= 4; lvl++) {
    const box = el('span', 'dg-hm-legend-box');
    box.dataset.level = String(lvl);
    legend.appendChild(box);
  }
  legend.appendChild(el('span', null, 'More'));
  footer.appendChild(legend);

  wrap.appendChild(footer);
  container.appendChild(wrap);
}

/**
 * 5. Compact 14-day Inline Sparkline (Polyline + Dots OR Completion Pip Strip)
 */
export function renderSparkline(
  container,
  { points = [], metricDirection = 'higher_is_better', accentColor = '#ff5a36' } = {}
) {
  if (!clearContainer(container)) return;
  const list = Array.isArray(points) ? points : [];
  const wrap = el('div', 'dg-sparkline');

  if (list.length === 0) {
    wrap.appendChild(el('span', 'dg-spark-empty', 'No recent activity'));
    container.appendChild(wrap);
    return;
  }

  const accent = sanitizeColor(accentColor);
  const lowerIsBetter = metricDirection === 'lower_is_better';

  const normalized = list.map((p, idx) => ({
    idx,
    playDate: p?.playDate ?? '',
    value: toFiniteNumber(p?.value),
    displayValue: p?.displayValue ?? null,
    completed: Boolean(p?.completed),
  }));

  const numericPts = normalized.filter((p) => p.value !== null);

  // Mode B: No numeric scores — sleek 14-day mini completion strip
  if (numericPts.length === 0) {
    const strip = el('div', 'dg-spark-strip');
    strip.setAttribute('role', 'img');
    strip.setAttribute('aria-label', `${list.length}-day completion strip`);

    for (const p of normalized) {
      const pip = el('div', `dg-spark-pip${p.completed ? ' is-done' : ''}`);
      pip.setAttribute('tabindex', '0');
      const statusText = p.completed ? (p.displayValue || 'Played') : 'Not logged';
      pip.setAttribute('aria-label', `${p.playDate}: ${statusText}`);
      if (p.completed) {
        pip.style.background = accent;
      }

      bindInteractiveEvents(pip, {
        onEnter: () => {
          showTooltip(pip, (tip) => {
            tip.appendChild(el('div', 'dg-tip-title', formatLongDate(p.playDate) || p.playDate));
            appendTooltipRow(tip, 'Status', statusText);
          });
        },
        onLeave: () => hideTooltip(pip),
      });

      strip.appendChild(pip);
    }

    wrap.appendChild(strip);
    container.appendChild(wrap);
    return;
  }

  // Mode A: Numeric SVG Sparkline (polyline + dots)
  const W = 260;
  const H = 42;
  const padX = 8;
  const padTop = 7;
  const padBottom = 9;
  const plotW = W - padX * 2;
  const plotH = H - padTop - padBottom;

  const min = Math.min(...numericPts.map((p) => p.value));
  const max = Math.max(...numericPts.map((p) => p.value));
  const span = max - min;

  const mapX = (i) => {
    if (normalized.length === 1) return W / 2;
    return padX + (i / (normalized.length - 1)) * plotW;
  };
  const mapY = (val) => {
    if (span === 0) return padTop + plotH / 2;
    const norm = (val - min) / span;
    const t = lowerIsBetter ? 1 - norm : norm;
    return H - padBottom - t * plotH;
  };

  const svg = svgEl('svg', {
    class: 'dg-spark-svg',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': `${list.length}-day score sparkline`,
  });

  svg.appendChild(
    svgEl('line', {
      class: 'dg-spark-baseline',
      x1: padX,
      y1: H - padBottom + 2,
      x2: W - padX,
      y2: H - padBottom + 2,
    })
  );

  const coords = numericPts.map((p) => ({
    x: mapX(p.idx),
    y: mapY(p.value),
    point: p,
  }));

  if (coords.length >= 2) {
    const polyPts = coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ');
    const areaD =
      `M ${coords[0].x.toFixed(2)} ${(H - padBottom).toFixed(2)} ` +
      coords.map((c) => `L ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(' ') +
      ` L ${coords[coords.length - 1].x.toFixed(2)} ${(H - padBottom).toFixed(2)} Z`;

    svg.appendChild(
      svgEl('path', {
        d: areaD,
        fill: accent,
        opacity: '0.14',
        'pointer-events': 'none',
      })
    );
    svg.appendChild(
      svgEl('polyline', {
        points: polyPts,
        fill: 'none',
        stroke: accent,
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'pointer-events': 'none',
      })
    );
  }

  const lastNumericIdx = numericPts[numericPts.length - 1].idx;

  for (const p of normalized) {
    const cx = mapX(p.idx);
    const hasVal = p.value !== null;
    const cy = hasVal ? mapY(p.value) : H - padBottom + 2;
    const labelText = hasVal
      ? p.displayValue || formatCompactNumber(p.value)
      : p.completed
        ? p.displayValue || 'Played'
        : 'Not logged';

    if (hasVal) {
      const isLatest = p.idx === lastNumericIdx;
      svg.appendChild(
        svgEl('circle', {
          cx,
          cy,
          r: isLatest ? 3.4 : 2.3,
          fill: accent,
          stroke: 'var(--surface-2, #efe7d4)',
          'stroke-width': isLatest ? 1.5 : 1,
          'pointer-events': 'none',
        })
      );
    } else if (p.completed) {
      svg.appendChild(
        svgEl('circle', {
          cx,
          cy,
          r: 2.3,
          fill: 'var(--surface-2, #efe7d4)',
          stroke: accent,
          'stroke-width': 1.4,
          'pointer-events': 'none',
        })
      );
    } else {
      svg.appendChild(
        svgEl('circle', {
          cx,
          cy,
          r: 1.4,
          fill: 'var(--muted, #786d65)',
          opacity: '0.35',
          'pointer-events': 'none',
        })
      );
    }

    const hit = svgEl('circle', {
      class: 'dg-hit-target',
      cx,
      cy,
      r: 7,
      tabindex: 0,
      role: 'img',
      'aria-label': `${p.playDate}: ${labelText}`,
    });

    bindInteractiveEvents(hit, {
      onEnter: () => {
        showTooltip(hit, (tip) => {
          tip.appendChild(el('div', 'dg-tip-title', formatShortDate(p.playDate) || p.playDate));
          appendTooltipRow(tip, hasVal ? 'Score' : 'Status', labelText);
        });
      },
      onLeave: () => hideTooltip(hit),
    });

    svg.appendChild(hit);
  }

  wrap.appendChild(svg);
  container.appendChild(wrap);
}
