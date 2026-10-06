// Meter interval files → Atlas interval records (CSV / TSV / Excel), the Atlas side of the Site Analysis
// Workbench's "Interval Data" tab. The parsing itself is the workbench's own code (interval-parse.js);
// this file holds what the workbench keeps in globals and DOM handlers: the import session, re-processing
// with overridden columns, the record stored in IndexedDB, and the summary shown on the Interval data tab.
//
// Pure (no DOM), so it runs in Node tests. Excel needs DecompressionStream (all current browsers, Node 18+).
import {
  readIntervalCSV, buildRAW, deriveAnalysis, detectCols, canonize, colLetter, edEncodeRaw, edDecodeRaw,
  zipEntries, zipRead, parseShared, sheetRows, xmlDec,
} from './interval-parse.js';

const valueHeader = (vt) => (vt === 'kW' ? 'kW (demand)' : 'kWh (energy)');
const canonRows = (got) => [['Timestamp', valueHeader(got.valueType)]].concat(got.canon);

/** Finish a state: build the time series from the chosen columns and refuse an empty result. */
function build(state) {
  state.series = buildRAW(state.file.rows, state.det);
  if (!state.series.kw.length) throw new Error('No readable timestamp and value rows were found. Check the date/time and value columns in the override panel.');
  return state;
}

/** CSV / TSV text from a file or the paste box. Throws an Error with a message fit to show the user. */
export function ingestCsvText(text, name = 'pasted.csv') {
  if (!text || !text.trim()) throw new Error('No data found in file.');
  const rd = readIntervalCSV(text);
  if (!rd.det || rd.det.dt < 0) throw new Error('Could not detect a date/time column. Open the file in a spreadsheet and check that it has a timestamp column and a kW or kWh column.');
  return build({ kind: 'csv', file: { name, rows: rd.rows, delim: rd.delim, preamble: rd.preamble }, det: rd.det });
}

function stateFromSheet(name, got, sheet, sheets, rows, buf) {
  const file = { name, rows: canonRows(got), delim: 'xlsx', xlsx: true };
  const det = detectCols(file.rows);
  det.dt = 0;
  det.val = 1;
  det.hasHeader = true;
  det.valueType = got.valueType;
  det.intervalMin = got.intervalMin;
  det.warnings = got.warnings;
  det.note = got.note;
  det.sheet = sheet;
  det.sheets = sheets;
  det.sheetHeaders = rows && rows.length > 0 ? rows[0] : null;
  return build({ kind: 'xlsx', file, det, xlsx: { buf, sheets, rows, sheet } });
}

/** An .xlsx / .xlsm workbook (ArrayBuffer). Picks the largest sheet that parses as interval data. */
export async function ingestXlsx(buf, name) {
  const entries = zipEntries(buf);
  const wb = await zipRead(buf, entries, 'xl/workbook.xml');
  if (!wb) throw new Error('Not an Excel workbook (xl/workbook.xml missing).');
  const rels = (await zipRead(buf, entries, 'xl/_rels/workbook.xml.rels')) || '';
  const ss = parseShared(await zipRead(buf, entries, 'xl/sharedStrings.xml'));
  const sheets = [];
  const sre = /<sheet [^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*\/>/g;
  let sm;
  while ((sm = sre.exec(wb))) {
    const rm = new RegExp(`Id="${sm[2]}"[^>]*Target="([^"]*)"`).exec(rels);
    const tgt = rm ? rm[1].replace(/^\/?(xl\/)?/, 'xl/') : null;
    if (tgt && entries[tgt]) sheets.push({ name: xmlDec(sm[1]), target: tgt, size: entries[tgt].csize });
  }
  if (!sheets.length) throw new Error('No worksheets found in the workbook.');
  const tabOrder = sheets.slice(); // workbook tab order for the picker
  const bySize = sheets.slice().sort((a, b) => b.size - a.size); // the data sheet is far larger than summary / pivot tabs
  let firstErr = null;
  for (const sh of bySize) {
    try {
      const rows = sheetRows(await zipRead(buf, entries, sh.target), ss);
      const got = canonize(rows, sh.name);
      return stateFromSheet(name, got, sh.name, tabOrder, rows, buf);
    } catch (e) {
      if (!firstErr) firstErr = e;
    }
  }
  throw firstErr || new Error('No usable interval data found in any sheet.');
}

/** Re-parse a different sheet of the same workbook without re-uploading it. */
export async function selectSheet(state, sheetName) {
  const x = state.xlsx;
  const sh = x && x.sheets.find((s) => s.name === sheetName);
  if (!sh) throw new Error(`Sheet "${sheetName}" not found.`);
  try {
    const entries = zipEntries(x.buf);
    const ss = parseShared(await zipRead(x.buf, entries, 'xl/sharedStrings.xml'));
    const rows = sheetRows(await zipRead(x.buf, entries, sh.target), ss);
    return stateFromSheet(state.file.name, canonize(rows, sh.name), sh.name, x.sheets, rows, x.buf);
  } catch (e) {
    throw new Error(`Sheet "${sheetName}": ${e.message}`);
  }
}

/**
 * Re-run with the columns / type the user chose. `ov` = { dt, tm, val, valueType, intervalMin, hasHeader } for CSV;
 * { dtCol, dateCol, timeCol, valCol, valueType } (blank = keep detected) for Excel.
 */
export function reprocess(state, ov) {
  if (state.kind === 'xlsx') {
    const hints = {};
    if (ov.dtCol != null && ov.dtCol !== '') hints.dtCol = +ov.dtCol;
    else {
      if (ov.dateCol != null && ov.dateCol !== '') hints.dateCol = +ov.dateCol;
      if (ov.timeCol != null && ov.timeCol !== '') hints.timeCol = +ov.timeCol;
    }
    if (ov.valCol != null && ov.valCol !== '') hints.valCol = +ov.valCol;
    if (ov.valueType) hints.valueType = ov.valueType;
    const x = state.xlsx;
    return stateFromSheet(state.file.name, canonize(x.rows, state.det.sheet || 'sheet', hints), state.det.sheet, x.sheets, x.rows, x.buf);
  }
  // CSV: work on a copy of the detection so a failed re-process leaves the current import intact.
  const det = JSON.parse(JSON.stringify(state.det));
  const nVal = +ov.val;
  const nType = ov.valueType;
  // The user took over the unit: whatever the file said (unit column / header / scale) no longer applies.
  if (nVal !== det.val || nType !== det.valueType) {
    det.warnings = (det.warnings || []).filter((w) => w !== det.unitAmbig);
    det.unitScale = 1;
    det.unitAmbig = '';
    det.unitCol = -1;
    det.unitSrc = `set manually in Override (${nType} in ${det.rawHeaders && det.rawHeaders[nVal] ? `"${det.rawHeaders[nVal]}"` : `col ${colLetter(nVal)}`})`;
  }
  det.tm = ov.tm != null ? +ov.tm : det.tm;
  det.dt = +ov.dt;
  det.val = nVal;
  det.valueType = nType;
  det.intervalMin = Math.max(1, +ov.intervalMin || 15);
  det.hasHeader = ov.hasHeader === true || ov.hasHeader === '1' || ov.hasHeader === 1;
  return build({ ...state, det });
}

/** Everything the Interval data tab shows about how a file was read; plain data so it can be stored. */
export function describe(state) {
  const det = state.det;
  const su = det.summary || { rowsParsed: state.series.kw.length, duplicates: 0, gaps: 0, gapMaxH: 0, shortFillable: 0 };
  return {
    kind: state.kind,
    name: state.file.name,
    layout: det.headers && det.headers.length ? 'long (header + one row per interval)' : 'generic timestamp + value',
    intervalMin: state.series.intervalMin,
    valueType: det.valueType,
    unitSrc: det.unitSrc || '',
    unitAmbig: det.unitAmbig || '',
    rows: su.rowsParsed,
    duplicates: su.duplicates,
    gaps: su.gaps,
    gapMaxH: su.gapMaxH,
    shortFillable: su.shortFillable,
    note: det.note || (state.kind === 'csv' ? csvNote(det) : ''),
    warnings: (det.warnings || []).slice(),
    sheet: det.sheet || null,
    sheets: det.sheets ? det.sheets.map((s) => s.name) : null,
    columns: columnChoices(state),
    selected: { dt: det.dt, tm: det.tm, val: det.val, hasHeader: det.hasHeader },
  };
}

function csvNote(det) {
  if (det.dt == null || det.dt < 0) return '';
  const nm = (ci) => {
    const h = (det.rawHeaders || [])[ci];
    return `col ${colLetter(ci)}${h ? ` ("${h}")` : ''}`;
  };
  const im = det.intervalMin;
  const p = [`Timestamp: ${nm(det.dt)}${det.tm >= 0 ? ` + ${nm(det.tm)}` : ''}`];
  p.push(`Value: ${nm(det.val)} as ${det.valueType === 'kWh' ? `energy per ${im}-min interval (kWh), converted to kW (× ${60 / im})` : 'kW demand'}`);
  if (det.unitSrc) p.push(`Unit: ${det.unitSrc}`);
  else if (det.unitAmbig) p.push('Unit NOT confirmed (see warning)');
  if (det.meterNote) p.push(det.meterNote);
  if (det.preamble > 0) p.push(`Skipped ${det.preamble} preamble line(s) above the header`);
  return p.join(' · ');
}

/** Column picker entries ("Col A — Date"): the sheet's own headers for Excel, the detected headers for CSV. */
function columnChoices(state) {
  const det = state.det;
  const isX = state.kind === 'xlsx' && det.sheetHeaders;
  const hdrs = isX ? det.sheetHeaders : det.headers || [];
  const n = isX ? hdrs.length : det.ncol;
  return Array.from({ length: n }, (_, i) => ({ index: i, label: `Col ${colLetter(i)}${hdrs[i] != null && hdrs[i] !== '' ? ` — ${hdrs[i]}` : ''}` }));
}

/** Month-by-month analysis for the charts (peak, average, worst day profile, daily envelope, heat map). */
export function analyze(series, source = '', meta = {}) {
  return deriveAnalysis(series, { source, valueType: meta.valueType || 'kW', cols: meta.cols });
}

/** The series back from a stored `raw` block (null when it is inconsistent). */
export function seriesFromRaw(raw) {
  return edDecodeRaw(raw);
}

/**
 * The record stored for an imported file. `model` follows the workbench's own save format with the summary
 * left blank, so "Download site file for the workbench" opens in the workbench, which re-derives it from `raw`.
 */
export function recordFromState(state, id, now = new Date()) {
  const raw = edEncodeRaw(state.series);
  const site = state.file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || 'Imported site';
  return {
    id,
    file_name: state.file.name,
    imported_at: now.toISOString(),
    source: 'interval-file',
    detection: describe(state),
    model: {
      meta: { customer: '', site, branch: '', iso: '', addr: '', voltage: '480', mdp: '', unit: '30/150', crit: '', prep: '', date: now.toISOString().slice(0, 10) },
      components: [],
      connections: [],
      photos: [],
      _seq: 1,
      analysis: { source: state.file.name, rows: 0, intervalMin: state.series.intervalMin, valueType: 'kW', cols: { dt: 0, val: 1 }, peakKW: null, monthly: [], daily: [] },
      tariffs: { mode: 'peak-shave', ratchetPct: 0.7, demandRate: null, monthly: [], lastImport: null },
      sizing: { unit: '30/150', nUnits: 1, mix: [], monthAchievable: null, sweep: [], monthlyTargets: null },
    },
    raw,
  };
}
