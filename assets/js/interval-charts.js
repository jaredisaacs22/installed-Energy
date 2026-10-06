// Interval data tab charts, the SVG counterparts of the workbench's four: monthly peak vs average,
// worst-day profile, year overview (daily peak and average, drag to zoom) and the month × hour heat map.
// They read the analysis block produced by interval-parse.js (deriveAnalysis).
import { h, s, num, showTip, hideTip } from './ui.js';
import { niceStep, hhmm } from './dispatch-chart.js';

const GREEN = '#008545';
const GRAY = '#939598';
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function yAxis(svg, { left, right, top, ph, W }, axisMax, step, y) {
  const grid = s('g', { class: 'grid' });
  const axis = s('g', { class: 'axis' });
  for (let v = 0; v <= axisMax + 1e-9; v += step) {
    grid.append(s('line', { x1: left, x2: W - right, y1: y(v), y2: y(v) }));
    axis.append(s('text', { x: left - 8, y: y(v) + 4, 'text-anchor': 'end' }, num(v)));
  }
  axis.append(s('text', { x: 12, y: top + ph / 2, 'text-anchor': 'middle', class: 'axis-title', transform: `rotate(-90 12 ${top + ph / 2})` }, 'kW'));
  svg.append(grid, axis);
  return axis;
}

const legend = (items) => h('div', { class: 'legend' }, items.map(([label, color, kind]) => h('span', {}, h('span', { class: `sw ${kind}`, style: kind === 'dash' ? { borderTopColor: color, color } : { background: color } }), label)));

const monthLabel = (r) => `${MON[r.m]} ${r.year || ''}`.trim();

/** Peak and average kW for each month of the data. */
export function monthlyPeakAvgChart(a) {
  const W = 540;
  const H = 300;
  const g = { left: 46, right: 10, top: 14, bottom: 34, W };
  const pw = W - g.left - g.right;
  g.ph = H - g.top - g.bottom;
  const months = a.monthly;
  const yMax = Math.max(1, ...months.map((r) => r.peakKW));
  const step = niceStep(yMax / 5);
  const axisMax = Math.ceil(yMax / step) * step;
  const y = (v) => g.top + g.ph - (v / axisMax) * g.ph;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dchart', role: 'img', 'aria-label': 'Monthly peak and average demand' });
  const axis = yAxis(svg, g, axisMax, step, y);
  const slot = pw / Math.max(1, months.length);
  months.forEach((r, i) => {
    const x0 = g.left + i * slot;
    const bw = slot * 0.34;
    const grp = s('g', {});
    [[r.peakKW, GREEN, x0 + slot * 0.12], [r.avgKW, GRAY, x0 + slot * 0.12 + bw + 2]].forEach(([v, color, x]) => {
      if (v > 0) grp.append(s('rect', { x, y: y(v), width: bw, height: g.top + g.ph - y(v), fill: color, rx: 2 }));
    });
    grp.append(s('rect', { x: x0, y: g.top, width: slot, height: g.ph, fill: 'transparent' }));
    grp.addEventListener('mousemove', (e) => showTip(e, monthLabel(r), [`Peak ${num(r.peakKW, 1)} kW`, `Average ${num(r.avgKW, 1)} kW`, `Load factor ${num((100 * r.avgKW) / r.peakKW, 1)}%`]));
    grp.addEventListener('mouseleave', hideTip);
    svg.append(grp);
    axis.append(s('text', { x: x0 + slot / 2, y: H - g.bottom + 18, 'text-anchor': 'middle' }, months.length > 8 ? `${MON[r.m]}${r.year ? ` ’${String(r.year).slice(2)}` : ''}` : monthLabel(r)));
  });
  return h('div', { class: 'dchart-wrap' }, svg, legend([['Peak kW', GREEN, 'line'], ['Average kW', GRAY, 'line']]));
}

/** The worst day of one month (the day holding the month's peak interval), on a 0–24 h axis. */
export function worstDayChart(entry) {
  const w = entry.worst;
  if (!w || !w.profile || !w.profile.length) return h('p', { class: 'muted' }, 'No sub-daily profile for this period.');
  const W = 540;
  const H = 300;
  const g = { left: 46, right: 12, top: 14, bottom: 34, W };
  const pw = W - g.left - g.right;
  g.ph = H - g.top - g.bottom;
  const yMax = Math.max(1, ...w.profile.map((p) => p.kW)) * 1.05;
  const step = niceStep(yMax / 5);
  const axisMax = Math.ceil(yMax / step) * step;
  const y = (v) => g.top + g.ph - (v / axisMax) * g.ph;
  const x = (hr) => g.left + (hr / 24) * pw;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dchart', role: 'img', 'aria-label': `Worst-day demand profile, ${entry.worstDay}` });
  const axis = yAxis(svg, g, axisMax, step, y);
  for (let hr = 0; hr <= 24; hr += 4) axis.append(s('text', { x: x(hr), y: H - g.bottom + 18, 'text-anchor': 'middle' }, String(hr)));
  axis.append(s('text', { x: g.left + pw / 2, y: H - 2, 'text-anchor': 'middle', class: 'axis-title' }, 'Hour of day'));
  const pts = w.profile.map((p) => [x(p.h), y(p.kW)]);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
  svg.append(s('path', { d: `${line}L${pts[pts.length - 1][0].toFixed(1)},${y(0)}L${pts[0][0].toFixed(1)},${y(0)}Z`, fill: 'rgba(0,133,69,0.12)', stroke: 'none' }));
  svg.append(s('path', { d: line, fill: 'none', stroke: GREEN, 'stroke-width': 2.2 }));
  const cross = s('line', { class: 'crosshair', x1: 0, x2: 0, y1: g.top, y2: g.top + g.ph, visibility: 'hidden' });
  const hit = s('rect', { x: g.left, y: g.top, width: pw, height: g.ph, fill: 'transparent' });
  hit.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const hr = Math.max(0, Math.min(24, (((e.clientX - box.left) / box.width) * W - g.left) / pw * 24));
    let best = w.profile[0];
    for (const p of w.profile) if (Math.abs(p.h - hr) < Math.abs(best.h - hr)) best = p;
    cross.setAttribute('x1', x(best.h));
    cross.setAttribute('x2', x(best.h));
    cross.setAttribute('visibility', 'visible');
    showTip(e, `${entry.worstDay} ${hhmm(best.h)}`, [`${num(best.kW, 1)} kW`]);
  });
  hit.addEventListener('mouseleave', () => {
    cross.setAttribute('visibility', 'hidden');
    hideTip();
  });
  svg.append(cross, hit);
  return h('div', { class: 'dchart-wrap' }, svg);
}

/**
 * Daily peak and average across the loaded range. `zoom` = { lo, hi } indices into a.daily (null = all).
 * Drag across the plot to zoom to those days; double-click to reset. `onZoom(lo, hi)` / `onReset()` re-render.
 */
export function yearOverviewChart(a, zoom, { onZoom, onReset }) {
  const dl = a.daily || [];
  if (dl.length < 2) return h('p', { class: 'muted' }, 'Fewer than two days of data.');
  const lo = Math.max(0, Math.min(zoom?.lo ?? 0, dl.length - 1));
  const hi = Math.max(lo, Math.min(zoom?.hi ?? dl.length - 1, dl.length - 1));
  const dz = dl.slice(lo, hi + 1);
  const zoomed = lo > 0 || hi < dl.length - 1;
  const W = 860;
  const H = 280;
  const g = { left: 56, right: 14, top: 14, bottom: 34, W };
  const pw = W - g.left - g.right;
  g.ph = H - g.top - g.bottom;
  const yMax = Math.max(1, ...dz.map((d) => d.max)) * 1.05;
  const step = niceStep(yMax / 5);
  const axisMax = Math.ceil(yMax / step) * step;
  const y = (v) => g.top + g.ph - (v / axisMax) * g.ph;
  const n = dz.length;
  const x = (i) => g.left + (i / (n - 1)) * pw;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dchart iv-year', role: 'img', 'aria-label': 'Daily peak and average demand across the loaded range' });
  const axis = yAxis(svg, g, axisMax, step, y);
  // x labels: the first of each month, or every few days when zoomed in
  const stride = zoomed && n <= 45 ? Math.max(1, Math.round(n / 9)) : 0;
  dz.forEach((d, i) => {
    const [yy, mm, dd] = d.d.split('-');
    const label = stride ? (i % stride === 0 ? `${mm}/${dd}` : null) : +dd === 1 ? `${MON[+mm - 1]} ’${yy.slice(2)}` : null;
    if (label && (stride || n < 400 || +mm % 1 === 0)) axis.append(s('text', { x: x(i), y: H - g.bottom + 18, 'text-anchor': 'middle' }, label));
  });
  const peakPts = dz.map((d, i) => [x(i), y(d.max)]);
  const peakLine = peakPts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
  svg.append(s('path', { d: `${peakLine}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`, fill: 'rgba(0,133,69,0.14)', stroke: 'none' }));
  svg.append(s('path', { d: peakLine, fill: 'none', stroke: GREEN, 'stroke-width': 1.8 }));
  svg.append(s('path', { d: dz.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.avg).toFixed(1)}`).join(''), fill: 'none', stroke: GRAY, 'stroke-width': 1.4, 'stroke-dasharray': '5 4' }));
  // the peak of the visible range
  let pk = 0;
  dz.forEach((d, i) => { if (d.max > dz[pk].max) pk = i; });
  svg.append(s('circle', { cx: x(pk), cy: y(dz[pk].max), r: 3.5, fill: GREEN, stroke: '#fff', 'stroke-width': 1.5 }));

  const cross = s('line', { class: 'crosshair', x1: 0, x2: 0, y1: g.top, y2: g.top + g.ph, visibility: 'hidden' });
  const sel = s('rect', { x: 0, y: g.top, width: 0, height: g.ph, fill: 'rgba(0,133,69,0.18)', stroke: 'rgba(0,133,69,0.6)', visibility: 'hidden' });
  const hit = s('rect', { x: g.left, y: g.top, width: pw, height: g.ph, fill: 'transparent', style: 'cursor:crosshair;touch-action:none' });
  const idxAt = (e) => {
    const box = svg.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    return Math.max(0, Math.min(n - 1, Math.round(((sx - g.left) / pw) * (n - 1))));
  };
  let drag = null;
  hit.addEventListener('pointerdown', (e) => {
    drag = { from: idxAt(e), to: idxAt(e) };
    hit.setPointerCapture?.(e.pointerId);
  });
  hit.addEventListener('pointermove', (e) => {
    const i = idxAt(e);
    if (drag) {
      drag.to = i;
      const a0 = Math.min(drag.from, drag.to);
      const a1 = Math.max(drag.from, drag.to);
      sel.setAttribute('x', x(a0));
      sel.setAttribute('width', Math.max(1, x(a1) - x(a0)));
      sel.setAttribute('visibility', 'visible');
      hideTip();
      return;
    }
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    showTip(e, dz[i].d, [`Daily peak ${num(dz[i].max, 1)} kW`, `Daily average ${num(dz[i].avg, 1)} kW`, `Daily minimum ${num(dz[i].min, 1)} kW`]);
  });
  const finish = (e) => {
    if (!drag) return;
    const a0 = Math.min(drag.from, drag.to);
    const a1 = Math.max(drag.from, drag.to);
    drag = null;
    sel.setAttribute('visibility', 'hidden');
    if (a1 - a0 >= 2) onZoom(lo + a0, lo + a1);
  };
  hit.addEventListener('pointerup', finish);
  hit.addEventListener('pointercancel', () => { drag = null; sel.setAttribute('visibility', 'hidden'); });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
  hit.addEventListener('dblclick', onReset);
  svg.append(cross, sel, hit);
  return h('div', { class: 'dchart-wrap' }, svg, legend([['Daily peak kW', GREEN, 'line'], ['Daily avg kW', GRAY, 'dash']]));
}

/** Average kW by month (rows) and hour of day (columns); darker green = higher. */
export function heatTable(a) {
  const grid = a.heat || [];
  let max = 0;
  for (const row of grid) for (const v of row) if (v != null && v > max) max = v;
  const color = (v) => {
    if (v == null) return '#f0f0f0';
    const t = max ? v / max : 0;
    return `rgb(${Math.round(255 - t * 254)},${Math.round(255 - t * 102)},${Math.round(255 - t * 203)})`;
  };
  const dark = (v) => max && v / max > 0.55;
  return h('div', { class: 'table-wrap' }, h('table', { class: 'heatmap' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Month'), Array.from({ length: 24 }, (_, i) => h('th', {}, String(i))))),
    h('tbody', {}, MON.map((m, r) => h('tr', {}, h('th', {}, m), Array.from({ length: 24 }, (_, c) => {
      const v = grid[r] ? grid[r][c] : null;
      return h('td', { style: { background: color(v), color: v != null && dark(v) ? '#fff' : 'inherit' }, title: v == null ? 'no data' : `${num(v, 1)} kW avg` }, v == null ? '' : String(Math.round(v)));
    })))),
  ));
}
