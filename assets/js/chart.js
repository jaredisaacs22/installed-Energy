// Horizontal stacked bar chart: annual value by stream group for each battery configuration.
import { h, s, usd, showTip, hideTip } from './ui.js';

export const STREAM_GROUPS = [
  { id: 'demand', label: 'Demand charges', color: 'var(--s1)', match: (st) => st.category === 'demand_charge' },
  { id: 'tags', label: 'Peak tags (capacity / transmission)', color: 'var(--s2)', match: (st) => st.category === 'coincident_peak' },
  { id: 'energy', label: 'Energy shifting', color: 'var(--s3)', match: (st) => st.category === 'energy_arbitrage' },
  { id: 'programs', label: 'DR & grid programs', color: 'var(--s4)', match: (st) => ['demand_response', 'performance_incentive', 'wholesale_market', 'capacity_tag'].includes(st.category) },
  { id: 'other', label: 'Other annual', color: 'var(--s5)', match: () => true },
];

export function groupStreams(streams, scenario = 'base') {
  const totals = Object.fromEntries(STREAM_GROUPS.map((g) => [g.id, 0]));
  const items = Object.fromEntries(STREAM_GROUPS.map((g) => [g.id, []]));
  for (const st of streams) {
    if (!(st.annual_usd > 0)) continue;
    if (scenario === 'base' && st.scenario !== 'base') continue;
    const g = STREAM_GROUPS.find((x) => x.match(st));
    totals[g.id] += st.annual_usd;
    items[g.id].push(st);
  }
  return { totals, items };
}

/**
 * @param results analysis.results
 * @param opts { selectedId, recommendedId, onSelect(configId), scenario }
 */
export function valueStackChart(results, opts = {}) {
  const scenario = opts.scenario || 'base';
  const rows = results.map((r) => ({ r, ...groupStreams(r.streams, scenario), net: scenario === 'base' ? r.totals.annual_base : r.totals.annual_upside }));
  const used = STREAM_GROUPS.filter((g) => rows.some((row) => row.totals[g.id] > 0));
  const maxV = Math.max(1, ...rows.map((row) => used.reduce((n, g) => n + row.totals[g.id], 0)));
  const step = niceStep(maxV / 4);
  const axisMax = Math.ceil(maxV / step) * step;

  const W = 860;
  const labelW = 170;
  const rightPad = 70;
  const rowH = 28;
  const barH = 16;
  const top = 8;
  const plotW = W - labelW - rightPad;
  const Hh = top + rows.length * rowH + 26;
  const x = (v) => labelW + (v / axisMax) * plotW;

  const svg = s('svg', { viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': `Annual value by stream for ${rows.length} battery configurations` });
  const grid = s('g', { class: 'grid' });
  const axis = s('g', { class: 'axis' });
  for (let v = 0; v <= axisMax + 1e-9; v += step) {
    grid.append(s('line', { x1: x(v), x2: x(v), y1: top - 4, y2: top + rows.length * rowH }));
    axis.append(s('text', { x: x(v), y: top + rows.length * rowH + 16, 'text-anchor': 'middle' }, usd(v, { compact: true })));
  }
  svg.append(grid, axis);

  rows.forEach((row, i) => {
    const y = top + i * rowH;
    const id = row.r.config.id;
    const g = s('g', {});
    const hit = s('rect', { class: id === opts.selectedId ? 'row-hit row-sel' : 'row-hit', x: 0, y, width: W, height: rowH, rx: 6 });
    hit.addEventListener('click', () => opts.onSelect?.(id));
    g.append(hit);
    const lbl = row.r.config.label.length > 26 ? row.r.config.label.slice(0, 25) + '…' : row.r.config.label;
    g.append(s('text', { class: 'rowlbl', x: labelW - 10, y: y + rowH / 2 + 4, 'text-anchor': 'end' }, (id === opts.recommendedId ? '★ ' : '') + lbl));
    let acc = 0;
    const segs = used.filter((grp) => row.totals[grp.id] > 0);
    segs.forEach((grp, k) => {
      const v = row.totals[grp.id];
      const x0 = x(acc);
      const x1 = x(acc + v);
      const gap = k < segs.length - 1 ? 2 : 0;
      const w = Math.max(0.5, x1 - x0 - gap);
      const last = k === segs.length - 1;
      const path = last ? roundedRight(x0, y + (rowH - barH) / 2, w, barH, Math.min(4, w)) : `M${x0},${y + (rowH - barH) / 2}h${w}v${barH}h${-w}z`;
      const seg = s('path', { class: 'seg-rect', d: path, fill: grp.color });
      seg.addEventListener('mousemove', (e) =>
        showTip(e, `${row.r.config.label} — ${grp.label}`, [usd(v) + '/yr', ...row.items[grp.id].slice(0, 4).map((st) => `${st.label}: ${usd(st.annual_usd)}`)]),
      );
      seg.addEventListener('mouseleave', hideTip);
      seg.addEventListener('click', () => opts.onSelect?.(id));
      g.append(seg);
      acc += v;
    });
    g.append(s('text', { class: 'total', x: x(acc) + 6, y: y + rowH / 2 + 4 }, usd(row.net, { compact: true })));
    svg.append(g);
  });
  svg.append(s('line', { class: 'baseline', x1: x(0), x2: x(0), y1: top - 4, y2: top + rows.length * rowH }));

  const legend = h(
    'div',
    { class: 'legend' },
    used.map((g) => h('span', {}, h('span', { class: 'sw', style: { background: g.color } }), g.label)),
    h('span', { class: 'muted' }, '★ recommended · labels show net annual value after losses'),
  );
  return h('div', { class: 'chart' }, legend, svg);
}

function roundedRight(x, y, w, hgt, r) {
  return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${hgt - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z`;
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}
