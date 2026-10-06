// Interval data tab of the Site screener: the Site Analysis Workbench's "Interval Data" tab, built in.
// Load a meter interval file (CSV / TSV / Excel, or a workbench site file), see how it was read, and review
// the load: peak and average demand, monthly peaks, worst days, the year overview and the month × hour heat map.
import { h, num, pct } from '../ui.js';
import { monthlyPeakAvgChart, worstDayChart, yearOverviewChart, heatTable, MON } from '../interval-charts.js';

const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm,.json,application/json';

/**
 * ctx = { rec, iv, analysis, live, persistent, busy, error, ui, rerender,
 *         onFile(file), onPaste(text), onRemove(), onReprocess(overrides), onSheet(name) }
 *   rec       stored record for the loaded file (null before anything is loaded)
 *   analysis  month-by-month analysis from the interval store (null before anything is loaded)
 *   live      the import session for this record, which can be re-processed (null after a reload)
 *   ui        { wd, zoom } view state kept by the screener: selected worst-day period, year-chart zoom
 */
export function intervalTab(ctx) {
  const { rec, analysis: a } = ctx;
  const parts = [importCard(ctx)];
  if (rec?.detection) parts.push(detectionCard(ctx));
  if (!rec || !a) {
    parts.push(h('div', { class: 'card empty' },
      h('h3', {}, 'No interval data yet'),
      h('p', { class: 'muted' }, 'Drop the site’s meter interval file above. The whole analysis is driven by it: the file sets the peak, the annual energy and each month’s worst day, and the Sizing and Savings tabs check the battery against every day of it. With only monthly bills, enter the peak and annual kWh in the form and the Atlas uses a building-type load shape.')));
    return h('div', { class: 'iv-tab' }, ...parts);
  }
  if (!rec.detection) parts.push(workbenchFileCard(rec, a));
  parts.push(...analysisCards(ctx));
  return h('div', { class: 'iv-tab' }, ...parts);
}

function importCard(ctx) {
  const input = h('input', { type: 'file', accept: ACCEPT, style: { display: 'none' }, 'aria-label': 'Meter interval file', onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) ctx.onFile(f); } });
  let over = false;
  const zone = h('div', {
    class: 'drop', role: 'button', tabindex: 0,
    onclick: () => input.click(),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } },
    ondragover: (e) => { e.preventDefault(); if (!over) { over = true; zone.classList.add('over'); } },
    ondragleave: () => { over = false; zone.classList.remove('over'); },
    ondrop: (e) => { e.preventDefault(); over = false; zone.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) ctx.onFile(f); },
  },
  ctx.busy
    ? [h('b', {}, `Parsing ${ctx.busy} …`), h('div', { class: 'small' }, 'Large utility exports can take a few seconds.')]
    : [h('b', {}, 'Drop a meter-interval file here'), ' or click to browse', h('div', { class: 'small' }, 'Excel workbooks (PSEG-LI, Con Ed, SCE, SDG&E exports), any datetime + demand CSV, or a workbench site file (.json)')]);
  const paste = h('textarea', { placeholder: 'datetime,kW\n2025-07-15 13:00,80.2 …', 'aria-label': 'Pasted CSV text', rows: 4 });
  return h('div', { class: 'card no-print' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Interval data'), h('span', { class: 'small muted' }, 'XLSX / CSV / TSV · detects date, kW or kWh, and interval length')),
    zone, input,
    ctx.error ? h('div', { class: 'iv-error', role: 'alert' }, h('b', {}, ctx.error.name), ` — ${ctx.error.msg}`) : null,
    h('details', { style: { marginTop: '10px' } }, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, 'Paste CSV text instead'),
      paste, h('div', { class: 'btn-row', style: { marginTop: '8px' } }, h('button', { class: 'btn small primary', type: 'button', onclick: () => ctx.onPaste(paste.value) }, 'Process pasted data'))),
    ctx.rec ? h('div', { class: 'btn-row', style: { marginTop: '10px' } }, h('button', { class: 'btn small', type: 'button', onclick: ctx.onRemove }, 'Remove interval data')) : null,
    !ctx.persistent && ctx.rec ? h('p', { class: 'small warn', style: { marginBottom: 0 } }, 'This browser is not keeping interval data between visits (storage is unavailable), so it will be lost on reload. Open the file again to restore it.') : null,
  );
}

const row = (label, value) => h('tr', {}, h('td', {}, label), h('td', {}, value));

function detectionCard(ctx) {
  const d = ctx.rec.detection;
  const live = ctx.live;
  const unit = d.kind === 'xlsx' ? d.valueType
    : d.unitAmbig ? [h('span', { class: 'warn-strong' }, `${d.valueType} — NOT CONFIRMED`), ' ', h('span', { class: 'small muted' }, '(assumed; see the warning below)')]
    : d.unitSrc ? [d.valueType, ' ', h('span', { class: 'small muted' }, `— ${d.unitSrc}`)] : d.valueType;
  const dup = d.duplicates ? h('span', { class: 'warn-strong' }, `${num(d.duplicates)} kept as separate intervals (not merged)`) : h('span', { class: 'good-strong' }, '0');
  let gaps;
  if (!d.gaps) gaps = h('span', { class: 'good-strong' }, '0');
  else gaps = h('span', { class: 'warn-strong' }, `${num(d.gaps)} detected (largest ≈ ${d.gapMaxH.toFixed(1)} h) — not filled${d.shortFillable > 0 ? `; ${num(d.shortFillable)} interval(s) in short gaps (≤1 h) are fillable but left as-is` : ''}`);
  return h('div', { class: 'card det-card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Detection summary'), h('span', { class: 'small muted' }, d.name)),
    h('table', { class: 'tbl det-tbl' }, h('tbody', {},
      row('File', d.name), row('Layout', d.layout), row('Detected interval', `${d.intervalMin} min`), row('Detected unit', unit),
      row('Rows parsed', num(d.rows)), row('Duplicate timestamps', dup), row('Gaps (honest — not interpolated)', gaps))),
    live ? overrides(ctx, d, live) : h('p', { class: 'small muted' }, 'To change the sheet or columns, open the file again; the choices are not kept between visits.'),
    d.note ? h('p', { class: 'small muted' }, d.note, d.sheet ? ` · sheet "${d.sheet}"` : '') : null,
    ...(d.warnings || []).map((w) => h('p', { class: 'warn-note' }, `⚠ ${w}`)),
  );
}

function overrides(ctx, d, live) {
  const isX = d.kind === 'xlsx';
  const opts = (sel, withAuto) => [withAuto ? h('option', { value: '' }, '— auto (keep detected) —') : null, ...d.columns.map((c) => h('option', { value: c.index, selected: sel === c.index }, c.label))];
  const sel = (id, children) => h('select', { id: `iv-${id}`, 'aria-label': id }, children);
  const field = (label, control) => h('div', { class: 'field' }, h('label', {}, label), control);
  const val = (id) => document.getElementById(`iv-${id}`)?.value ?? '';
  const typeSel = sel('type', ['kW', 'kWh'].map((t) => h('option', { value: t, selected: d.valueType === t }, t === 'kW' ? 'kW (demand)' : 'kWh (energy)')));
  let grid;
  let go;
  if (isX) {
    grid = [
      d.sheets && d.sheets.length > 1 ? field('Sheet / tab', h('select', { id: 'iv-sheet', 'aria-label': 'sheet', onchange: (e) => ctx.onSheet(e.target.value) }, d.sheets.map((n) => h('option', { value: n, selected: n === d.sheet }, n)))) : null,
      field('Combined date+time col', sel('dt', opts(null, true))),
      field('Date-only col (if split)', sel('date', opts(null, true))),
      field('Time-of-day col (if split)', sel('time', opts(null, true))),
      field('Value column', sel('val', opts(null, true))),
      field('Value type', typeSel),
    ];
    go = () => ctx.onReprocess({ dtCol: val('dt'), dateCol: val('date'), timeCol: val('time'), valCol: val('val'), valueType: val('type') });
  } else {
    const sc = d.selected;
    grid = [
      field('Date / time column', sel('dt', opts(sc.dt, false))),
      field('Time-of-day col (if split)', sel('tm', [h('option', { value: -1, selected: sc.tm < 0 }, '— none (date + time in one column) —'), ...opts(sc.tm, false)])),
      field('Value column', sel('val', opts(sc.val, false))),
      field('Value type', typeSel),
      field('Interval (min)', h('input', { id: 'iv-int', type: 'number', min: 1, value: d.intervalMin, 'aria-label': 'interval minutes' })),
      field('First row', sel('hdr', [h('option', { value: '1', selected: sc.hasHeader }, 'Header'), h('option', { value: '0', selected: !sc.hasHeader }, 'Data')])),
    ];
    go = () => ctx.onReprocess({ dt: val('dt'), tm: val('tm'), val: val('val'), valueType: val('type'), intervalMin: val('int'), hasHeader: val('hdr') === '1' });
  }
  return h('details', { class: 'ov-details' },
    h('summary', {}, 'Override interpretation ', h('span', { class: 'small muted' }, '— auto-detected; click to change sheet or columns')),
    h('div', { class: 'dgrid' }, ...grid, h('div', { class: 'field', style: { alignSelf: 'flex-end' } }, h('button', { class: 'btn small primary', type: 'button', onclick: go }, 'Re-process'))));
}

function workbenchFileCard(rec, a) {
  return h('div', { class: 'card det-card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Loaded from a workbench site file'), h('span', { class: 'small muted' }, rec.file_name)),
    h('table', { class: 'tbl det-tbl' }, h('tbody', {}, row('File', rec.file_name), row('Interval', `${a.intervalMin} min`), row('Rows', num(a.rows)), row('Range', `${a.rangeStart} → ${a.rangeEnd}`))),
    h('p', { class: 'small muted' }, 'The workbench already read this meter file, so its interval data is used as saved. Open the original CSV or Excel file here to see how it is interpreted.'));
}

function kpi(label, value, unit, sub, accent) {
  return h('div', { class: `kpi${accent ? ' highlight' : ''}${label === 'Data range' ? ' kpi-date' : ''}` }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value, unit ? h('small', {}, ` ${unit}`) : null), sub ? h('div', { class: 'sub' }, sub) : null);
}

function analysisCards(ctx) {
  const a = ctx.analysis;
  const ui = ctx.ui;
  const dayCount = a.daily && a.daily.length ? a.daily.length : a.rows && a.intervalMin ? Math.round((a.rows * a.intervalMin) / 1440) : 0;
  const series = ctx.rec.trimNote || ctx.rec.detection?.warnings?.find((w) => /^Multi-year file/.test(w));
  const out = [];
  out.push(h('div', { class: 'iv-kpis' },
    kpi('Peak demand', num(a.peakKW, 1), 'kW', '', true),
    kpi('Average demand', num(a.avgKW, 1), 'kW'),
    kpi('Load factor', pct(a.loadFactor), '', a.loadFactor < 0.4 ? 'peaky — short shave window' : ''),
    kpi(`Energy (${dayCount} days)`, num(a.energyKWh), 'kWh'),
    kpi('Peak − average', num(a.peakMinusAvg, 1), 'kW', 'NOT the savings figure'),
    kpi('Data range', a.rangeStart || '—', '', `${num(a.rows)} rows · ${a.intervalMin} min${a.rangeEnd ? ` · to ${a.rangeEnd}` : ''}`),
  ));
  if (dayCount > 0 && dayCount < 350) out.push(h('div', { class: 'callout warn' }, h('p', { class: 'small', style: { margin: 0 } }, h('b', {}, `${dayCount} days of data loaded — less than a full year.`), ' Monthly and annual figures cover only the loaded range; annual savings are understated if billing months are missing.')));
  else if (series) out.push(h('div', { class: 'callout' }, h('p', { class: 'small', style: { margin: 0 } }, series)));

  const sel = ui.wd == null || ui.wd >= a.monthly.length ? a.monthly.length - 1 : ui.wd;
  const wdSelect = h('select', { 'aria-label': 'Billing period for the worst-day profile', style: { maxWidth: '100%', marginBottom: '8px' }, onchange: (e) => { ui.wd = e.target.value === '' ? null : +e.target.value; ctx.rerender(); } },
    a.monthly.map((r, i) => h('option', { value: i, selected: i === sel }, `${MON[r.m]}${r.year ? ` ${r.year}` : ''} — worst day ${r.worstDay || '?'}${r.worst && r.worst.peak != null ? ` (${num(r.worst.peak, 1)} kW)` : ''}`)));
  const wd = a.monthly[sel];
  const pkH = wd?.worst?.peakH;
  const pkTime = pkH != null ? `${String(Math.floor(pkH)).padStart(2, '0')}:${String(Math.round((pkH % 1) * 60)).padStart(2, '0')}` : '';
  out.push(h('div', { class: 'grid-2 iv-charts' },
    h('div', { class: 'card' }, h('h3', {}, 'Monthly Peak vs Average'), monthlyPeakAvgChart(a)),
    h('div', { class: 'card' }, h('h3', {}, 'Worst-Day Profile (per billing period)'), wdSelect,
      wd ? h('p', { class: 'small ink2', style: { margin: '0 0 4px' } }, `Worst day ${wd.worstDay} — peak ${num(wd.worst.peak, 1)} kW${pkTime ? ` at ${pkTime}` : ''}`) : null,
      wd ? worstDayChart(wd) : null),
  ));
  const zoom = ui.zoom;
  const zoomed = zoom && zoom.lo != null && (zoom.lo > 0 || zoom.hi < a.daily.length - 1);
  out.push(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Year Overview — daily demand'),
      h('div', { class: 'iv-zoombar' },
        zoomed ? h('span', { class: 'small', style: { color: 'var(--green-dark)', fontWeight: 600 } }, `${a.daily[zoom.lo].d} → ${a.daily[zoom.hi].d} (${zoom.hi - zoom.lo + 1} days)`) : null,
        h('span', { class: 'small muted' }, 'Drag across to zoom · double-click to reset'),
        zoomed ? h('button', { class: 'btn small', type: 'button', onclick: () => { ui.zoom = null; ctx.rerender(); } }, 'Reset zoom') : null)),
    yearOverviewChart(a, zoom, { onZoom: (lo, hi) => { ui.zoom = { lo, hi }; ctx.rerender(); }, onReset: () => { ui.zoom = null; ctx.rerender(); } })));
  out.push(h('div', { class: 'card' },
    h('h3', {}, 'Monthly peaks & worst days'),
    h('p', { class: 'small ink2' }, 'Worst day = the day containing each calendar month’s peak interval (the billing period is taken as the calendar month). This drives sizing.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Billing period', 'Peak kW', 'Peak time', 'Avg kW', 'Load factor', 'Energy kWh', 'Worst day'].map((t, i) => h('th', { class: i && i < 6 ? 'num' : '' }, t)))),
      h('tbody', {}, a.monthly.map((r) => {
        const t = r.peakTime ? new Date(r.peakTime) : null;
        const when = t && !Number.isNaN(t.getTime()) ? `${t.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}, ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '—';
        return h('tr', {}, h('td', {}, `${MON[r.m]}${r.year ? ` ${r.year}` : ''}`), h('td', { class: 'num' }, num(r.peakKW, 1)), h('td', {}, when), h('td', { class: 'num' }, num(r.avgKW, 1)), h('td', { class: 'num' }, pct(r.avgKW / r.peakKW)), h('td', { class: 'num' }, num(r.energyKWh)), h('td', {}, r.worstDay || '—'));
      }))))));
  out.push(h('div', { class: 'card heat-card' },
    h('h3', {}, 'Seasonal heat map — average kW by month × hour'),
    h('p', { class: 'small ink2' }, 'Average demand by month (rows) and hour of day (columns); darker green = higher. Hover a cell for its exact average.'),
    heatTable(a)));
  return out;
}
