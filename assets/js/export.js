// Dependency-free CSV, ZIP (store) and XLSX writers + the export table builders.
// Tables are arrays of plain objects; column order follows the first row's keys.

// ---------- CSV ----------
export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = columnsOf(rows);
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'number' ? (Number.isFinite(v) ? String(round(v)) : '') : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

function columnsOf(rows) {
  const cols = [];
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) seen.add(k), cols.push(k);
  return cols;
}

const round = (x) => Math.round(x * 10000) / 10000;

// ---------- ZIP (no compression) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{name, data: string|Uint8Array}] → Uint8Array zip */
export function zip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // store
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) out.set(c, p), (p += c.length);
  return out;
}

// ---------- XLSX ----------
const xmlEsc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // strip characters illegal in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function colRef(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function sheetXml(rows) {
  const cols = rows.length ? columnsOf(rows) : [];
  const cell = (v, r, c, style = 0) => {
    const ref = `${colRef(c)}${r}`;
    if (v == null || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${round(v)}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  };
  const lines = [];
  lines.push(`<row r="1">${cols.map((c, i) => cell(c, 1, i, 1)).join('')}</row>`);
  rows.forEach((row, ri) => {
    lines.push(`<row r="${ri + 2}">${cols.map((c, ci) => cell(row[c], ri + 2, ci)).join('')}</row>`);
  });
  const widths = cols.map((c) => Math.min(60, Math.max(10, c.length + 2, ...rows.slice(0, 50).map((r) => String(r[c] ?? '').length * 0.9))));
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    (cols.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w.toFixed(1)}" customWidth="1"/>`).join('')}</cols>` : '') +
    `<sheetData>${lines.join('')}</sheetData></worksheet>`
  );
}

const safeSheetName = (n, used) => {
  let s = String(n).replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
  let k = 2;
  while (used.has(s.toLowerCase())) s = `${s.slice(0, 28)}_${k++}`;
  used.add(s.toLowerCase());
  return s;
};

/** sheets: [{name, rows}] → Uint8Array (.xlsx) */
export function xlsx(sheets) {
  const used = new Set();
  const named = sheets.map((s) => ({ ...s, name: safeSheetName(s.name, used) }));
  const files = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        named.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    },
    {
      name: 'xl/styles.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>',
    },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) })),
  ];
  return zip(files);
}

// ---------- Table builders (the export schema; see docs/EXPORT-SCHEMA.md) ----------
export const EXPORT_SCHEMA_VERSION = '1.0';

const siteKey = (a) => ({ site_id: a.site.id || '', site_name: a.site.name || '' });

export function configRows(a) {
  return a.results.map((r) => ({
    ...siteKey(a),
    config_id: r.config.id,
    config_label: r.config.label,
    recommended: r === a.recommended ? 'yes' : '',
    units: r.config.units,
    kw: r.config.kw,
    kwh: r.config.kwh,
    duration_hr: r.config.durationHr,
    installed_cost_usd: r.config.installedCostUsd,
    annual_value_base_usd: r.totals.annual_base,
    annual_value_upside_usd: r.totals.annual_upside,
    upfront_incentives_base_usd: r.totals.upfront_base,
    upfront_incentives_upside_usd: r.totals.upfront_upside,
    om_usd_per_yr: r.omPerYear,
    net_cost_base_usd: r.finance.base.netCost,
    simple_payback_base_yr: r.finance.base.simplePayback,
    npv_base_usd: r.finance.base.npv,
    irr_base: r.finance.base.irr,
    simple_payback_upside_yr: r.finance.upside.simplePayback,
    npv_upside_usd: r.finance.upside.npv,
    programs_not_enrolled: r.strategy ? r.strategy.skipped_labels.join(' | ') : '',
    constraint_status: r.constraints.status,
    constraint_issues: r.constraints.checks
      .filter((c) => c.severity === 'critical' || c.severity === 'caution')
      .map((c) => `[${c.severity}] ${c.title}`)
      .join(' | '),
  }));
}

export function streamRows(a) {
  const rows = [];
  for (const r of a.results) {
    for (const s of r.streams) {
      rows.push({
        ...siteKey(a),
        market: a.site.jurisdiction,
        utility_id: a.site.utility_id,
        tariff_id: a.site.tariff_id,
        config_id: r.config.id,
        kw: r.config.kw,
        kwh: r.config.kwh,
        stream_key: s.key,
        category: s.category,
        label: s.label,
        program_id: s.program_id || '',
        scenario: s.scenario,
        confidence: s.confidence,
        annual_usd: s.annual_usd,
        upfront_usd: s.upfront_usd,
        kw_credited: s.kw_used,
        rate: s.rate,
        unit: s.unit,
        term_years: s.term_years ?? '',
        flags: (s.flags || []).join('|'),
        basis: s.basis_text,
      });
    }
  }
  return rows;
}

const pipe = (arr) => (Array.isArray(arr) ? arr.join('|') : '');

/** Machine-usable tariff parameters for an interval-data bill model. */
export function tariffRows(a) {
  const t = a.tariff;
  if (!t) return [];
  const base = { tariff_id: t.id, tariff_name: t.name, utility_id: t.utility_id, effective_date: t.effective_date || '', confidence: t.confidence || '' };
  const rows = [];
  for (const dc of t.demand_charges || []) {
    rows.push({ ...base, element: 'demand_charge', label: dc.label, component: dc.component || '', basis: dc.basis || '', rate: dc.rate_usd_per_kw_month, unit: dc.basis === 'daily' ? '$/kW-day' : '$/kW-month', months: pipe(dc.months?.length ? dc.months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), window_start_hr: dc.window?.start ?? '', window_end_hr: dc.window?.end ?? '', days: dc.days || '', notes: dc.notes || '' });
  }
  for (const er of t.energy_rates || []) {
    rows.push({ ...base, element: 'energy_rate', label: er.label, component: er.component || '', basis: '', rate: er.rate_usd_per_kwh, unit: '$/kWh', months: pipe(er.months), window_start_hr: er.window?.start ?? '', window_end_hr: er.window?.end ?? '', days: er.days || '', notes: er.hours || '' });
  }
  for (const cp of t.coincident_peak_charges || []) {
    rows.push({ ...base, element: 'coincident_peak', label: cp.type, component: cp.passthrough || '', basis: cp.how_set || '', rate: cp.est_value_usd_per_kw_year, unit: '$/kW-yr', months: '', window_start_hr: '', window_end_hr: '', days: '', notes: cp.derivation || '' });
  }
  if (t.ratchet) {
    rows.push({ ...base, element: 'ratchet', label: t.ratchet.applies_to || 'ratchet', component: '', basis: '', rate: t.ratchet.pct, unit: 'fraction', months: '', window_start_hr: '', window_end_hr: '', days: '', notes: `lookback ${t.ratchet.lookback_months ?? '?'} months` });
  }
  return rows;
}

export function programRows(a) {
  return a.programs.map(({ program: p, eligible, reason, viaAggregator }) => ({
    ...siteKey(a),
    program_id: p.id,
    name: p.name,
    category: p.category,
    status: p.status,
    eligible_for_recommended: eligible ? (viaAggregator ? 'via aggregator' : 'yes') : 'no',
    reason: reason || '',
    method: p.valuation?.method || '',
    rate: p.valuation?.rate,
    unit: p.valuation?.unit || '',
    months_per_year: p.valuation?.months_per_year ?? '',
    duration_basis_hr: p.valuation?.duration_basis_hr ?? p.dispatch?.event_duration_hr ?? '',
    event_window: p.dispatch?.window || '',
    season: p.dispatch?.season || '',
    typical_events_per_year: p.dispatch?.typical_events_per_year ?? '',
    max_events_per_year: p.dispatch?.max_events_per_year ?? '',
    min_kw: p.eligibility?.min_kw ?? '',
    max_kw: p.eligibility?.max_kw ?? '',
    min_kwh: p.eligibility?.min_kwh ?? '',
    max_kwh: p.eligibility?.max_kwh ?? '',
    term_years: p.valuation?.term_years ?? '',
    conflicts_with: pipe(p.stacking?.conflicts_with),
    confidence: p.confidence || '',
    last_verified: p.last_verified || '',
    source_url: p.sources?.[0]?.url || '',
  }));
}

export function limitRows(a) {
  const L = a.limits;
  const rows = [
    ['service_kva', L.serviceKva, 'kVA', 'Service capacity from voltage × amps'],
    ['nec_705_12_max_inverter_kw', L.nec120?.maxInverterKw, 'kW', 'Max inverter kW on a load-side (backfed breaker) connection under the 120% rule'],
    ['charging_headroom_overnight_kw', L.chargeHeadroomKw, 'kW', '80% continuous service capacity minus overnight load'],
    ['charging_headroom_at_peak_kw', L.peakChargeHeadroomKw, 'kW', '80% continuous service capacity minus site peak'],
    ['useful_discharge_ceiling_kw', L.usefulKwCeiling, 'kW', 'Non-export: discharge capped near site load during events'],
    ['min_load_kw', L.minLoadKw, 'kW', 'Minimum load (input or design-day estimate)'],
    ['indoor_max_kwh_per_fire_area', L.indoorMaxKwh, 'kWh', 'Fire code aggregate for Li-ion indoors without special approval'],
    ['unit_max_kwh_without_large_scale_test', L.unitMaxKwh, 'kWh', 'Per-unit size above which UL 9540A data + AHJ approval are needed'],
    ...Object.entries(L.maxUnitsBySpace || {}).map(([pid, n]) => [`max_units_by_space_${pid}`, n, 'units', 'Available area ÷ product footprint']),
    ...(L.interconnectionTracks || []).map((t) => [`interconnection_track_${t.name}`, t.max_kw, 'kW', [t.conditions, t.typical_timeline].filter(Boolean).join(' ')]),
  ];
  return rows.map(([limit, value, unit, note]) => ({ ...siteKey(a), limit, value: value ?? '', unit, note }));
}

export function panelRows(a) {
  return [
    ...a.panel.map((n) => ({ ...siteKey(a), source: 'site review', persona: n.persona, severity: n.severity, title: n.title, text: n.text })),
    ...a.briefing.map((n) => ({ ...siteKey(a), source: 'market briefing', persona: n.persona_id || n.persona, severity: n.severity, title: n.topic, text: n.note })),
  ];
}

export function inputRows(a) {
  const s = a.site;
  const rows = [];
  for (const [k, v] of Object.entries(s)) {
    if (Array.isArray(v)) rows.push({ section: 'site', key: k, value: v.join(',') });
    else if (v && typeof v === 'object') {
      // Nested user entries (bill rate overrides, program overrides, event windows, shave overrides).
      for (const [k2, v2] of Object.entries(v)) {
        if (v2 && typeof v2 === 'object') for (const [k3, v3] of Object.entries(v2)) rows.push({ section: 'site', key: `${k}.${k2}.${k3}`, value: v3 ?? '' });
        else rows.push({ section: 'site', key: `${k}.${k2}`, value: v2 ?? '' });
      }
    } else rows.push({ section: 'site', key: k, value: v ?? '' });
  }
  for (const [k, v] of Object.entries(a.assumptions)) rows.push({ section: 'assumption', key: k, value: v });
  rows.push({ section: 'meta', key: 'export_schema_version', value: EXPORT_SCHEMA_VERSION });
  rows.push({ section: 'meta', key: 'generated_at', value: new Date().toISOString() });
  return rows;
}

export function siteWorkbookSheets(a, readme) {
  return [
    { name: 'README', rows: readme },
    { name: 'Inputs', rows: inputRows(a) },
    { name: 'Configs', rows: configRows(a) },
    { name: 'ValueStreams', rows: streamRows(a) },
    { name: 'TariffParams', rows: tariffRows(a) },
    { name: 'Programs', rows: programRows(a) },
    { name: 'SiteLimits', rows: limitRows(a) },
    { name: 'Panel', rows: panelRows(a) },
  ];
}

export const README_ROWS = [
  { sheet: 'Inputs', description: 'Site inputs and modeling assumptions used for this run (one key per row).' },
  { sheet: 'Configs', description: 'One row per battery configuration: size, cost, base/upside annual value, incentives, payback, NPV, IRR, constraint status.' },
  { sheet: 'ValueStreams', description: 'Long format, one row per configuration × value stream. Join to Configs on site_id + config_id.' },
  { sheet: 'TariffParams', description: 'Machine-usable tariff elements (demand charges with months/hour windows, energy rates, coincident-peak $/kW-yr, ratchet) for an interval-data bill model.' },
  { sheet: 'Programs', description: 'Programs available in the territory with rates, event durations, size thresholds, stacking conflicts, and eligibility for the recommended config.' },
  { sheet: 'SiteLimits', description: 'Electrical, code and space limits that cap battery size at this site.' },
  { sheet: 'Panel', description: 'Expert-panel review notes (simulated advisory personas) and market briefings.' },
  { sheet: '(all)', description: 'Indicative screening estimates, not bankable. Rates change; check confidence and last_verified before investment decisions.' },
];

/** Trigger a browser download. */
export function download(filename, data, mime) {
  const blob = data instanceof Uint8Array ? new Blob([data], { type: mime }) : new Blob([data], { type: mime || 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

/** Minimal CSV parser (RFC 4180 quotes) for portfolio import. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') row.push(field), (field = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
