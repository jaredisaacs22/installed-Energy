// Savings-tab charts, modeled on the Site Analysis Workbench's Sizing tab: worst-day dispatch
// (original load, shaved load, target), state of charge, and monthly demand savings.
import { h, s, num, usd, showTip, hideTip } from './ui.js';

const COLORS = { original: '#49525e', shaved: '#008545', shavedFill: 'rgba(0,133,69,0.10)', target: '#c99400', soc: '#0a9396', socFill: 'rgba(10,147,150,0.12)', bar: '#008545' };

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

const hhmm = (hours) => {
  const hh = Math.floor(hours + 1e-9);
  const mm = Math.round((hours - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

/** Generic frame: y axis 0..max with gridlines, x axis 0..24 h. Returns helpers. */
function frame({ W = 860, H = 300, left = 56, right = 16, top = 12, bottom = 34, yMax, yLabel, yFmt = (v) => num(v) }) {
  const step = niceStep(yMax / 5);
  const axisMax = Math.ceil(yMax / step) * step || 1;
  const pw = W - left - right;
  const ph = H - top - bottom;
  const x = (hr) => left + (hr / 24) * pw;
  const y = (v) => top + ph - (v / axisMax) * ph;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dchart' });
  const grid = s('g', { class: 'grid' });
  const axis = s('g', { class: 'axis' });
  for (let v = 0; v <= axisMax + 1e-9; v += step) {
    grid.append(s('line', { x1: left, x2: W - right, y1: y(v), y2: y(v) }));
    axis.append(s('text', { x: left - 8, y: y(v) + 4, 'text-anchor': 'end' }, yFmt(v)));
  }
  for (let hr = 0; hr <= 24; hr += 4) axis.append(s('text', { x: x(hr), y: H - bottom + 18, 'text-anchor': 'middle' }, String(hr)));
  axis.append(s('text', { x: left + pw / 2, y: H - 2, 'text-anchor': 'middle', class: 'axis-title' }, 'Hour of day'));
  axis.append(s('text', { x: 12, y: top + ph / 2, 'text-anchor': 'middle', class: 'axis-title', transform: `rotate(-90 12 ${top + ph / 2})` }, yLabel));
  svg.append(grid, axis);
  return { svg, x, y, W, H, left, right, top, bottom, pw, ph };
}

const path = (pts) => pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');

/** Step path for interval data: each value holds for its interval. */
function stepPts(vals, dt, x, y) {
  const pts = [];
  vals.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    pts.push([x(i * dt), y(v)], [x((i + 1) * dt), y(v)]);
  });
  return pts;
}

/** Crosshair + tooltip layer over the plot area. */
function hoverLayer(f, n, dt, lines, title) {
  const cross = s('line', { class: 'crosshair', x1: 0, x2: 0, y1: f.top, y2: f.top + f.ph, visibility: 'hidden' });
  const hit = s('rect', { x: f.left, y: f.top, width: f.pw, height: f.ph, fill: 'transparent' });
  const toIdx = (evt) => {
    const box = f.svg.getBoundingClientRect();
    const sx = ((evt.clientX - box.left) / box.width) * f.W;
    return Math.max(0, Math.min(n - 1, Math.floor(((sx - f.left) / f.pw) * 24 / dt)));
  };
  hit.addEventListener('mousemove', (evt) => {
    const i = toIdx(evt);
    const cx = f.x((i + 0.5) * dt);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    showTip(evt, title(i), lines(i));
  });
  hit.addEventListener('mouseleave', () => {
    cross.setAttribute('visibility', 'hidden');
    hideTip();
  });
  f.svg.append(cross, hit);
}

/**
 * Worst-day dispatch: original load (dashed), shaved load (green, filled), target caps (gold dashed).
 * sim: simulateDay result; caps: per-interval caps (Infinity = no demand charge in that interval).
 */
export function dispatchDayChart({ load, sim, caps, dtHours, label }) {
  const finiteCaps = caps.filter((c) => c !== Infinity);
  const yMax = Math.max(1, ...load.filter(Number.isFinite), ...sim.shaved) * 1.08;
  const f = frame({ yMax, yLabel: 'kW' });
  const sh = stepPts(sim.shaved, dtHours, f.x, f.y);
  if (sh.length) {
    const area = [...sh, [sh[sh.length - 1][0], f.y(0)], [sh[0][0], f.y(0)]];
    f.svg.append(s('path', { d: `${path(area)}Z`, fill: COLORS.shavedFill, stroke: 'none' }));
  }
  f.svg.append(s('path', { d: path(stepPts(load, dtHours, f.x, f.y)), fill: 'none', stroke: COLORS.original, 'stroke-width': 2, 'stroke-dasharray': '5 4' }));
  f.svg.append(s('path', { d: path(sh), fill: 'none', stroke: COLORS.shaved, 'stroke-width': 2.5 }));
  if (finiteCaps.length) {
    // Draw each run of equal caps as its own dashed segment (caps differ by window).
    let runStart = 0;
    for (let i = 1; i <= caps.length; i++) {
      if (i === caps.length || caps[i] !== caps[runStart]) {
        if (caps[runStart] !== Infinity) f.svg.append(s('line', { x1: f.x(runStart * dtHours), x2: f.x(i * dtHours), y1: f.y(caps[runStart]), y2: f.y(caps[runStart]), stroke: COLORS.target, 'stroke-width': 2, 'stroke-dasharray': '7 5' }));
        runStart = i;
      }
    }
  }
  hoverLayer(f, load.length, dtHours, (i) => [
    `Load ${Number.isFinite(load[i]) ? `${num(load[i], 1)} kW` : '—'}`,
    `Shaved ${num(sim.shaved[i], 1)} kW`,
    caps[i] === Infinity ? 'No demand charge this interval' : `Target ${num(caps[i], 1)} kW`,
    sim.flow[i] > 0.05 ? `Battery discharging ${num(sim.flow[i], 1)} kW` : sim.flow[i] < -0.05 ? `Battery charging ${num(-sim.flow[i], 1)} kW` : 'Battery idle',
  ], (i) => `${label ? `${label} ` : ''}${hhmm(i * dtHours)}`);
  f.svg.setAttribute('role', 'img');
  f.svg.setAttribute('aria-label', `Worst-day load before and after the battery${label ? `, ${label}` : ''}`);
  return h('div', { class: 'dchart-wrap' }, f.svg, legend([['Original load', COLORS.original, 'dash'], ['Shaved load', COLORS.shaved, 'line'], ['Target', COLORS.target, 'dash']]));
}

/** State of charge (kWh stored) across the day. */
export function socChart({ sim, storedKwh, dtHours }) {
  const yMax = Math.max(1, storedKwh) * 1.05;
  const f = frame({ yMax, yLabel: 'kWh stored', W: 460, H: 250, left: 52, yFmt: (v) => num(v) });
  const pts = [[f.x(0), f.y(storedKwh)], ...sim.soc.map((v, i) => [f.x((i + 1) * dtHours), f.y(v)])];
  f.svg.append(s('path', { d: `${path([...pts, [pts[pts.length - 1][0], f.y(0)], [pts[0][0], f.y(0)]])}Z`, fill: COLORS.socFill, stroke: 'none' }));
  f.svg.append(s('path', { d: path(pts), fill: 'none', stroke: COLORS.soc, 'stroke-width': 2 }));
  hoverLayer(f, sim.soc.length, dtHours, (i) => [`${num(sim.soc[i], 1)} kWh stored (${Math.round((100 * sim.soc[i]) / storedKwh)}%)`], (i) => `End of ${hhmm(i * dtHours)}`);
  f.svg.setAttribute('role', 'img');
  f.svg.setAttribute('aria-label', 'Battery energy stored across the day');
  return h('div', { class: 'dchart-wrap' }, f.svg, legend([['Energy stored (kWh)', COLORS.soc, 'line']]));
}

/** Monthly demand savings, one bar per month; click selects the month. */
export function monthlySavingsChart({ months, selected, onSelect }) {
  const W = 860;
  const H = 220;
  const left = 64;
  const right = 12;
  const top = 14;
  const bottom = 30;
  const vals = months.map((m) => m.usd || 0);
  const step = niceStep(Math.max(1, ...vals) / 4);
  const axisMax = Math.ceil(Math.max(1, ...vals) / step) * step;
  const pw = W - left - right;
  const ph = H - top - bottom;
  const bw = pw / 12;
  const y = (v) => top + ph - (v / axisMax) * ph;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dchart', role: 'img', 'aria-label': 'Demand-charge savings by month' });
  const grid = s('g', { class: 'grid' });
  const axis = s('g', { class: 'axis' });
  for (let v = 0; v <= axisMax + 1e-9; v += step) {
    grid.append(s('line', { x1: left, x2: W - right, y1: y(v), y2: y(v) }));
    axis.append(s('text', { x: left - 8, y: y(v) + 4, 'text-anchor': 'end' }, usd(v, { compact: true })));
  }
  svg.append(grid, axis);
  const maxI = vals.indexOf(Math.max(...vals));
  months.forEach((m, i) => {
    const x0 = left + i * bw + bw * 0.18;
    const w = bw * 0.64;
    const v = vals[i];
    const yt = y(v);
    const hgt = Math.max(0, top + ph - yt);
    const r = Math.min(4, hgt / 2, w / 2);
    // Rounded top, square baseline.
    const d = hgt > 0 ? `M${x0},${top + ph} L${x0},${yt + r} Q${x0},${yt} ${x0 + r},${yt} L${x0 + w - r},${yt} Q${x0 + w},${yt} ${x0 + w},${yt + r} L${x0 + w},${top + ph} Z` : '';
    const g = s('g', { class: `mbar${m.month === selected ? ' sel' : ''}`, tabindex: 0, role: 'button', 'aria-label': `${m.name}: ${usd(v)}` });
    if (d) g.append(s('path', { d, fill: COLORS.bar, opacity: m.month === selected ? 1 : 0.72 }));
    g.append(s('rect', { x: left + i * bw, y: top, width: bw, height: ph, fill: 'transparent' }));
    axis.append(s('text', { x: left + i * bw + bw / 2, y: H - bottom + 18, 'text-anchor': 'middle', class: m.month === selected ? 'sel' : '' }, m.name));
    if (i === maxI && v > 0) svg.append(s('text', { x: x0 + w / 2, y: yt - 5, 'text-anchor': 'middle', class: 'bar-label' }, usd(v, { compact: true })));
    g.addEventListener('mousemove', (evt) => showTip(evt, m.name, [`Demand savings ${usd(v)}`, `${num(m.reduction, 1)} kW reduction`]));
    g.addEventListener('mouseleave', hideTip);
    g.addEventListener('click', () => onSelect?.(m.month));
    g.addEventListener('keydown', (evt) => (evt.key === 'Enter' || evt.key === ' ') && onSelect?.(m.month));
    svg.append(g);
  });
  return h('div', { class: 'dchart-wrap' }, svg);
}

function legend(items) {
  return h('div', { class: 'legend' }, items.map(([label, color, kind]) => h('span', {}, h('span', { class: `sw ${kind}`, style: kind === 'dash' ? { borderTopColor: color } : { background: color } }), label)));
}
