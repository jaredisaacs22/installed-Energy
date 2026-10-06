// Interval-file ingest (the Interval data tab). The CSV cases mirror the Site Analysis Workbench's own
// self-tests for its importer (units, preamble, split date/time, multi-meter, ISO dates) so a regression
// against the original behaviour is caught here. All data is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ingestCsvText, ingestXlsx, selectSheet, reprocess, describe, analyze, recordFromState, seriesFromRaw } from '../assets/js/interval-ingest.js';
import { parseDT, parseUnitLabel } from '../assets/js/interval-parse.js';
import { decodeRaw, buildInterval } from '../assets/js/workbench.js';
import { workbook, excelSerial } from './xlsx-fixture.mjs';

const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const hm = (q) => `${Math.floor(q / 4)}:${String((q % 4) * 15).padStart(2, '0')}`;
const maxOf = (kw) => kw.reduce((m, x) => (x > m ? x : m), -Infinity);

/** Baltimore-style layout: 4-line preamble, Type|Meter|Date|Start Time|Usage|Usage Unit, 2 days x 96 quarter-hours. */
function balt(meters, unit, dateFmt) {
  const L = ['Name,SUNBELT RENTALS INC,,,,', 'Address,7601 S PULASKI HWY BALTIMORE MD 21237,,,,', 'Account Number,2529590000,,,,', ',,,,,', 'Type,Meter,Date,Start Time,Usage,Usage Unit'];
  let n = 0;
  for (const m of meters) {
    for (let d = 1; d <= 2; d++) {
      for (let q = 0; q < 96; q++) {
        n++;
        const ds = dateFmt === 'iso' ? `2025-01-0${d}` : `1/${d}/2025`;
        L.push(`Electric Usage,${m.id},${ds},${hm(q)},${m.val(d, q)},${typeof unit === 'function' ? unit(n) : unit}`);
      }
    }
  }
  return L.join('\n');
}
const base = (d, q) => (d === 2 && q === 58 ? 3.6 : +(1 + q / 1000).toFixed(3)); // day 2 at 14:30 = 3.6 → the peak
const one = [{ id: 'D1-1', val: base }];

test('ingest CSV: kWh per 15 min with the unit in its own column is converted to kW (the Baltimore case)', () => {
  const s = ingestCsvText(balt(one, 'kWh'), 'balt.csv');
  const { det, series } = s;
  assert.equal(s.file.preamble, 4);
  assert.ok(det.hasHeader);
  assert.equal(det.headers[det.val], 'usage');
  assert.ok(det.tm >= 0, 'date and Start Time are paired');
  assert.equal(series.times.length, 192);
  assert.equal(series.times[1] - series.times[0], 15 * 60000);
  assert.deepEqual([series.times[0].getDate(), series.times[0].getHours(), series.times[0].getMinutes()], [1, 0, 0]);
  assert.equal(det.valueType, 'kWh');
  assert.equal(det.unitScale, 1);
  assert.match(det.unitSrc, /Usage Unit/);
  assert.equal(det.unitAmbig, '');
  assert.ok(near(series.kw[0], 4) && near(maxOf(series.kw), 14.4), `${series.kw[0]} / ${maxOf(series.kw)}`);
  assert.equal(det.warnings.filter((w) => /duplicate|gaps/.test(w)).length, 0);
  assert.equal(det.intervalMin, 15);
  assert.equal(det.summary.duplicates, 0);
  assert.match(describe(s).note, /D1-1/);
});

test('ingest CSV: Wh, MWh and kW unit labels are scaled from the file, never guessed', () => {
  const wh = ingestCsvText(balt([{ id: 'D1-1', val: (d, q) => +(base(d, q) * 1000).toFixed(3) }], 'Wh'));
  assert.equal(wh.det.valueType, 'kWh');
  assert.equal(wh.det.unitScale, 0.001);
  assert.ok(near(maxOf(wh.series.kw), 14.4));
  const mwh = ingestCsvText(balt([{ id: 'D1-1', val: (d, q) => +(base(d, q) / 1000).toFixed(6) }], 'MWh'));
  assert.equal(mwh.det.unitScale, 1000);
  assert.ok(near(maxOf(mwh.series.kw), 14.4, 1e-6));
  const kw = ingestCsvText(balt([{ id: 'D1-1', val: (d, q) => +(base(d, q) * 4).toFixed(3) }], 'kW'));
  assert.equal(kw.det.valueType, 'kW');
  assert.ok(near(kw.series.kw[0], 4) && near(maxOf(kw.series.kw), 14.4), 'kW is demand already, not multiplied again');
});

test('ingest CSV: an unclear unit is flagged, never defaulted silently', () => {
  const mix = ingestCsvText(balt(one, (n) => (n % 2 ? 'kWh' : 'kW')));
  assert.match(mix.det.unitAmbig, /NOT confirmed/);
  assert.equal(mix.det.warnings[0], mix.det.unitAmbig);
  assert.equal(mix.det.unitSrc, '');
  const rv = ingestCsvText(balt(one, 'kVARh'));
  assert.match(rv.det.unitAmbig, /NOT confirmed/);
  assert.equal(rv.det.unitScale, 1);
  const mw = ingestCsvText(balt(one, 'mWh'));
  assert.match(mw.det.unitAmbig, /NOT confirmed/);
  assert.equal(parseUnitLabel('mWh'), null);
  assert.equal(parseUnitLabel('MWh').k, 1000);
  assert.equal(parseUnitLabel('KWH').t, 'kWh');
  assert.equal(parseUnitLabel('Wh').k, 0.001);
  const nu = ingestCsvText('Timestamp,Load\n1/1/2025 0:00,5\n1/1/2025 0:15,6\n1/1/2025 0:30,7\n1/1/2025 0:45,8');
  assert.equal(nu.det.valueType, 'kW');
  assert.match(nu.det.unitAmbig, /not stated/);
  const ex = ingestCsvText('Timestamp,kW\n1/1/2025 0:00,5\n1/1/2025 0:15,6\n1/1/2025 0:30,7\n1/1/2025 0:45,8');
  assert.equal(ex.det.unitAmbig, '');
  assert.equal(ex.series.kw[3], 8);
  assert.match(ex.det.unitSrc, /header/);
});

test('ingest CSV: several meters keep ONE and name it; a dormant meter that ties on rows never wins', () => {
  const zero = { id: 'M-2', val: () => 0 };
  const live = { id: 'M-1', val: base };
  const mm = ingestCsvText(balt([zero, live], 'kWh'));
  const w = mm.det.warnings.join('|');
  assert.equal(mm.series.kw.length, 192);
  assert.ok(near(maxOf(mm.series.kw), 14.4));
  assert.match(w, /using M-1 \(192 of 384 rows, 100% of the usage\)/);
  assert.match(w, /Not used: M-2 \(192 rows, 0%/);
  assert.match(w, /NOT added/);
  assert.match(describe(mm).note, /M-1 \(kept\)/);
  // more rows beats more energy: a short, hot meter must not replace the full one
  const short = [{ id: 'S-1', val: (d, q) => (q < 20 && d === 1 ? 50 : 0.5) }];
  const text = `${balt([{ id: 'L-1', val: () => 1 }], 'kWh')}\n${balt(short, 'kWh').split('\n').slice(5, 35).join('\n').replace(/D1-1|S-1/g, 'S-1')}`;
  const mm2 = ingestCsvText(text);
  assert.equal(mm2.series.kw.length, 192);
  assert.match(mm2.det.warnings.join('|'), /using L-1/);
  assert.ok(near(maxOf(mm2.series.kw), 4));
});

test('ingest CSV: re-processing replaces warnings rather than stacking them', () => {
  const s = ingestCsvText(balt([{ id: 'M-2', val: () => 0 }, { id: 'M-1', val: base }], 'kWh'));
  const again = reprocess(reprocess(s, { dt: s.det.dt, tm: s.det.tm, val: s.det.val, valueType: s.det.valueType, intervalMin: 15, hasHeader: true }), { dt: s.det.dt, tm: s.det.tm, val: s.det.val, valueType: s.det.valueType, intervalMin: 15, hasHeader: true });
  assert.equal(again.det.warnings.filter((w) => /Multiple meters/.test(w)).length, 1);
  assert.equal(again.det.warnings.filter((w) => /NOT confirmed/.test(w)).length, 0);
});

test('ingest CSV: overriding the unit takes over from what the file said', () => {
  const s = ingestCsvText(balt(one, 'kVARh'));
  assert.match(s.det.unitAmbig, /NOT confirmed/);
  const o = reprocess(s, { dt: s.det.dt, tm: s.det.tm, val: s.det.val, valueType: 'kW', intervalMin: 15, hasHeader: true });
  assert.equal(o.det.unitAmbig, '');
  assert.match(o.det.unitSrc, /set manually/);
  assert.equal(o.det.valueType, 'kW');
  assert.equal(o.det.warnings.filter((w) => /NOT confirmed/.test(w)).length, 0);
  assert.equal(s.det.valueType, 'kWh', 'the previous import is left intact');
});

test('ingest CSV: ISO dates are local midnight, with no phantom December month', () => {
  const d0 = parseDT('2025-01-01');
  assert.deepEqual([d0.getFullYear(), d0.getMonth(), d0.getDate(), d0.getHours()], [2025, 0, 1, 0]);
  assert.equal(parseDT('2025-13-01'), null);
  assert.equal(parseDT('2025-01-32'), null);
  const iso = ingestCsvText(balt(one, 'kWh', 'iso'));
  assert.deepEqual([iso.series.times[0].getMonth(), iso.series.times[0].getDate(), iso.series.times[0].getHours()], [0, 1, 0]);
  assert.equal(iso.series.trimNote, null);
  assert.ok(near(maxOf(iso.series.kw), 14.4));
});

test('ingest CSV: Sacramento and Westchester layouts still read as before', () => {
  const sac = ['Service Agreement,Start Date Time,End Date Time,Usage,Usage Unit,Peak Demand,Demand Unit'];
  for (let q = 0; q < 8; q++) sac.push(`8630330034,1/1/2025 ${hm(q)},1/1/2025 ${hm(q + 1)},${3.2 + q / 100},KWH,${12.8 + q / 10},KW`);
  const sr = ingestCsvText(sac.join('\n'));
  assert.equal(sr.file.preamble, 0);
  assert.equal(sr.det.tm, -1);
  assert.equal(sr.det.valueType, 'kWh');
  assert.match(sr.det.unitSrc, /Usage Unit/);
  assert.doesNotMatch(sr.det.unitSrc, /Demand Unit/);
  assert.ok(near(sr.series.kw[0], 12.8));
  const wc = ['Name,,,,,,,,,', 'Address,"300 E SANDFORD BLVD, MOUNT VERNON NY 10550",,,,,,,,', 'Account Number,XX-XXXX,,,,,,,,', 'Service,4412577994,,,,,,,,', 'Meter,7654136000,,,,,,,,', ',,,,,,,,,', 'TYPE,DATE,START TIME,END TIME,USAGE (kWh),DEMAND (kW),REACTIVE POWER (kVAR),APPARENT POWER (kVA),POWER FACTOR (PF),NOTES'];
  for (let k = 0; k < 12; k++) {
    const sm = k * 5;
    const em = sm + 4;
    wc.push(`Electric usage,1/1/2025,0:${sm < 10 ? '0' : ''}${sm},0:${em < 10 ? '0' : ''}${em},0.9,${10.75 + k},0.38,10.76,1,`);
  }
  const wr = ingestCsvText(wc.join('\n'));
  assert.equal(wr.file.preamble, 6);
  assert.equal(wr.det.valueType, 'kW');
  assert.match(wr.det.rawHeaders[wr.det.val], /DEMAND/);
  assert.match(wr.det.rawHeaders[wr.det.tm], /START/);
  assert.equal(wr.det.intervalMin, 5);
  assert.ok(near(wr.series.kw[0], 10.75));
});

test('ingest CSV: empty or timestamp-less input is refused with a message', () => {
  assert.throws(() => ingestCsvText('   \n'), /No data found/);
  assert.throws(() => ingestCsvText('a,b\nfoo,bar\nbaz,qux'), /(date\/time column|readable)/);
});

/** A year of 15-minute data as CSV, with the peak in July. */
function yearCsv(year = 2025) {
  const L = ['Timestamp,kW'];
  const start = new Date(year, 0, 1);
  for (let i = 0; i < 365 * 96; i++) {
    const d = new Date(start.getTime() + i * 15 * 60000);
    const h = d.getHours() + d.getMinutes() / 60;
    const kw = 40 + 30 * Math.max(0, Math.sin(((h - 6) / 14) * Math.PI)) + (d.getMonth() === 6 ? 25 : 0);
    L.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')},${kw.toFixed(2)}`);
  }
  return L.join('\n');
}

test('interval analysis: peak, monthly worst days, daily envelope and heat map', () => {
  const s = ingestCsvText(yearCsv(), 'year.csv');
  const a = analyze(s.series, 'year.csv');
  assert.equal(a.rows, 365 * 96);
  assert.equal(a.monthly.length, 12);
  assert.equal(a.daily.length, 365);
  assert.equal(a.rangeStart, '2025-01-01');
  assert.equal(a.rangeEnd, '2025-12-31');
  assert.ok(near(a.peakKW, 95, 0.5), `peak ${a.peakKW}`);
  const jul = a.monthly.find((r) => r.m === 6);
  assert.equal(jul.peakKW, a.peakKW);
  assert.match(jul.worstDay, /^2025-07-/);
  assert.ok(jul.worst.profile.length >= 90);
  assert.equal(a.heat.length, 12);
  assert.equal(a.heat[0].length, 24);
  assert.ok(near(a.loadFactor, a.avgKW / a.peakKW, 1e-12));
});

test('interval record: round-trips through the workbench raw format into the Atlas engine input', () => {
  const s = ingestCsvText(yearCsv(), 'Store 123_main.csv');
  const rec = recordFromState(s, 'wb-test', new Date('2026-01-02T03:04:05Z'));
  assert.equal(rec.model.meta.site, 'Store 123 main');
  assert.equal(rec.raw.v, 1);
  assert.equal(rec.raw.n, 365 * 96);
  assert.equal(rec.detection.name, 'Store 123_main.csv');
  const back = seriesFromRaw(rec.raw);
  assert.equal(back.kw.length, s.series.kw.length);
  assert.equal(back.times[1000].getTime(), s.series.times[1000].getTime());
  const iv = buildInterval(decodeRaw(rec.raw));
  assert.equal(iv.monthsCovered, 12);
  assert.ok(near(iv.peak_kw, maxOf(s.series.kw), 1e-3));
});

// ---- Excel -----------------------------------------------------------------------------------

test('ingest Excel: reads the data sheet, ignores the summary tab, and lets the user switch sheets', async () => {
  const data = [['Date', 'Interval Start', 'kW']];
  for (let i = 0; i < 96 * 3; i++) {
    const d = 1 + Math.floor(i / 96);
    const q = i % 96;
    data.push([excelSerial(2025, 1, d, Math.floor(q / 4), (q % 4) * 15), excelSerial(2025, 1, d, Math.floor(q / 4), (q % 4) * 15), 50 + q / 4]);
  }
  const buf = workbook([
    { name: 'Summary', rows: [['Average of kW', 'x'], ['a', 1], ['b', 2]] },
    { name: 'Interval Data', rows: data },
  ]);
  const s = await ingestXlsx(buf, 'meter.xlsx');
  assert.equal(s.kind, 'xlsx');
  assert.equal(s.det.sheet, 'Interval Data');
  assert.equal(s.series.kw.length, 96 * 3);
  assert.equal(s.det.valueType, 'kW');
  assert.equal(s.det.intervalMin, 15);
  assert.ok(near(maxOf(s.series.kw), 50 + 95 / 4));
  assert.deepEqual(s.det.sheets.map((x) => x.name), ['Summary', 'Interval Data']);
  assert.deepEqual(describe(s).sheets, ['Summary', 'Interval Data']);
  await assert.rejects(() => selectSheet(s, 'Summary'), /pivot|too few|Summary/);
  const same = await selectSheet(s, 'Interval Data');
  assert.equal(same.series.kw.length, s.series.kw.length);
  // As in the workbench, a value type chosen in the override only applies together with a chosen value column.
  const o = reprocess(s, { valCol: 2, valueType: 'kWh' });
  assert.equal(o.det.valueType, 'kWh');
  assert.ok(near(maxOf(o.series.kw), (50 + 95 / 4) * 4), 'kWh per 15 min is converted to kW');
});

test('ingest Excel: a pivot / average-day sheet is refused rather than read', async () => {
  const buf = workbook([{ name: 'Pivot', rows: [['Average of kW', 'x'], ['a', 1], ['b', 2], ['c', 3]] }]);
  await assert.rejects(() => ingestXlsx(buf, 'pivot.xlsx'), /pivot|average/i);
});

test('ingest Excel: a file that is not a workbook is refused', async () => {
  await assert.rejects(() => ingestXlsx(new Uint8Array(64).buffer, 'x.xlsx'), /Not a valid \.xlsx/);
});
