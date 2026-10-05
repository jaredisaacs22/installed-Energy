// Interchange with the Sunbelt BESS Site Analysis Workbench (<site>-site.json).
//
// The workbench saves one JSON per site: meta (customer, site, ISO, address, voltage), analysis,
// tariffs (monthly billed kW and demand $), sizing (selected Viridi system, per-month achievable
// targets), revenue, economics, and the full interval data under `raw` (wall-clock timestamps,
// delta + run-length encoded). Its loader keeps keys it does not know, so Atlas results ride along
// under `atlas` and the file still opens in the workbench (and its sibling tools).
//
// Everything here is pure (no DOM) so it can be unit-tested in Node.

export const WORKBENCH_UNIT_MAP = {
  '30/150': 'B30-150',
  '65/200': 'B65-200',
  '200/600': 'B200-600',
  '230/418': 'B200-418', // workbench lists 230 kW; the Atlas catalog lists 200 kW (rating to confirm)
};

/** Wall-clock parts of a workbench "lm" integer: ((((y*12)+mo)*31+(d-1))*1440)+h*60+mi. */
export function lmParts(v) {
  const mi = v % 60;
  v = (v - mi) / 60;
  const h = v % 24;
  v = (v - h) / 24;
  const d = v % 31;
  v = (v - d) / 31;
  const mo = v % 12;
  const y = (v - mo) / 12;
  return { y, mo, d: d + 1, h, mi };
}

/**
 * Decode the workbench `raw` block ({v:1, n, dt, b, r:[[count, delta]], kw}).
 * Returns { stamps: number[] (lm ints), kw: number[], dtMin } or null when the block is inconsistent
 * (rejected rather than guessed, as the workbench itself does).
 */
export function decodeRaw(o) {
  if (!o || o.v !== 1 || !o.n || !Array.isArray(o.kw) || o.kw.length !== o.n) return null;
  const stamps = new Array(o.n);
  let cur = o.b;
  let k = 0;
  stamps[k++] = cur;
  for (const [count, delta] of o.r || []) {
    for (let j = 0; j < count && k < o.n; j++) {
      cur += delta;
      stamps[k++] = cur;
    }
  }
  if (k !== o.n) return null;
  return { stamps, kw: o.kw.map((x) => (Number.isFinite(+x) ? +x : NaN)), dtMin: o.dt || 15 };
}

const pad = (x) => String(x).padStart(2, '0');
const DAYS_IN_MONTH = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Build the per-month day matrices Atlas needs from decoded interval data.
 * Sub-15-minute data is averaged to 15-minute demand intervals (the usual billing interval).
 * Returns {
 *   dtHours, slots, months: {1..12: {days:[{date, weekday, kw:number[]}], envelope:number[], typical:number[], peak, daysPresent}},
 *   peak_kw, annual_kwh, min_kw, p05_kw, start, end, days, coverage, years
 * }
 */
export function buildInterval(decoded) {
  if (!decoded || !decoded.kw.length) return null;
  const dtMin = decoded.dtMin >= 15 ? decoded.dtMin : 15;
  const slots = Math.round(1440 / dtMin);
  const dtHours = dtMin / 60;
  const byDay = new Map();
  for (let i = 0; i < decoded.kw.length; i++) {
    const v = decoded.kw[i];
    if (!Number.isFinite(v)) continue;
    const p = lmParts(decoded.stamps[i]);
    const key = `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}`;
    let day = byDay.get(key);
    if (!day) {
      day = { date: key, y: p.y, month: p.mo + 1, sum: new Array(slots).fill(0), n: new Array(slots).fill(0) };
      byDay.set(key, day);
    }
    const slot = Math.min(slots - 1, Math.floor((p.h * 60 + p.mi) / dtMin));
    // Duplicate slots (DST fall-back hour, sub-15-min data) are averaged within the slot.
    day.sum[slot] += v;
    day.n[slot] += 1;
  }
  const months = {};
  const all = [];
  let energy = 0;
  let present = 0;
  let peak = 0;
  const years = new Set();
  const dates = [...byDay.keys()].sort();
  for (const key of dates) {
    const d = byDay.get(key);
    const kw = d.sum.map((s, i) => (d.n[i] ? s / d.n[i] : NaN));
    const have = kw.filter(Number.isFinite).length;
    if (have < slots * 0.5) continue; // too sparse to trust as a day
    years.add(d.y);
    const [y, mo, dd] = key.split('-').map(Number);
    const weekday = new Date(Date.UTC(y, mo - 1, dd)).getUTCDay();
    const m = (months[d.month] ||= { days: [], peak: 0 });
    m.days.push({ date: key, weekday, kw });
    for (const v of kw) {
      if (!Number.isFinite(v)) continue;
      energy += v * dtHours;
      present += 1;
      all.push(v);
      if (v > peak) peak = v;
      if (v > m.peak) m.peak = v;
    }
  }
  if (!all.length) return null;
  for (const m of Object.values(months)) {
    m.envelope = new Array(slots).fill(0).map((_, i) => Math.max(0, ...m.days.map((d) => (Number.isFinite(d.kw[i]) ? d.kw[i] : 0))));
    const wk = m.days.filter((d) => d.weekday >= 1 && d.weekday <= 5);
    const src = wk.length ? wk : m.days;
    m.typical = new Array(slots).fill(0).map((_, i) => {
      const vals = src.map((d) => d.kw[i]).filter(Number.isFinite);
      return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : 0;
    });
    m.daysPresent = m.days.length;
  }
  all.sort((a, b) => a - b);
  const coveredDays = present / slots;
  return {
    dtHours,
    slots,
    months,
    peak_kw: peak,
    annual_kwh: coveredDays > 0 ? (energy * 365) / coveredDays : null,
    min_kw: all[0],
    p05_kw: all[Math.floor(all.length * 0.005)],
    start: dates[0],
    end: dates[dates.length - 1],
    days: Math.round(coveredDays * 10) / 10,
    monthsCovered: Object.keys(months).length,
    years: years.size,
    resampledFrom: decoded.dtMin < 15 ? decoded.dtMin : null,
  };
}

/** Calendar days in month m (1-12), for scaling a month's sampled days to a billing month. */
export const daysInMonth = (m) => DAYS_IN_MONTH[m - 1];

/** Two-letter state from a free-text address ("Islip, NY 11751" → "NY"). */
export function stateFromAddress(addr) {
  const m = String(addr || '').toUpperCase().match(/\b(MA|CT|NY|IL|TX|CA|HI|NJ|PA|RI|NH|VT|ME|OH|MI|IN|WI|FL|GA|AZ|NV|CO|WA|OR)\b(?:\s+\d{5})?\s*$/);
  return m ? m[1] : null;
}

const NYC_PLACES = /(NEW YORK|MANHATTAN|BROOKLYN|BRONX|QUEENS|STATEN ISLAND|ASTORIA|FLUSHING|JAMAICA|LONG ISLAND CITY|HARLEM)/;

/** Atlas market code from workbench ISO + address; null when the site is outside covered markets. */
export function marketFor(meta) {
  const iso = String(meta?.iso || '').toUpperCase();
  const st = stateFromAddress(meta?.addr);
  if (/PSEG|LIPA|LONG ISLAND/.test(iso)) return { code: null, reason: 'PSEG Long Island is not in the Atlas markets (NYC is Con Edison only).' };
  if (st === 'NY') return NYC_PLACES.test(String(meta?.addr || '').toUpperCase()) || /CON ?ED/.test(iso) ? { code: 'NY-NYC' } : { code: 'NY-NYC', reason: 'Address is in New York State; Atlas covers Con Edison (NYC) only. Confirm the utility.' };
  if (['MA', 'CT', 'IL', 'TX', 'CA', 'HI'].includes(st)) return { code: st };
  if (/ERCOT/.test(iso)) return { code: 'TX' };
  if (/CAISO|SCE|SDG|PG&E/.test(iso)) return { code: 'CA' };
  if (/HECO|HAWAII|MECO|HELCO|KIUC|KAUAI|MAUI|OAHU/.test(iso)) return { code: 'HI', reason: 'Assumed Hawaii from the utility name; confirm.' };
  if (/ISO-?NE/.test(iso)) return { code: null, reason: 'ISO-NE site: pick Massachusetts or Connecticut.' };
  if (/PJM|COMED|MISO|AMEREN/.test(iso)) return { code: 'IL', reason: 'Assumed Illinois from the ISO; confirm.' };
  if (/NYISO/.test(iso)) return { code: 'NY-NYC', reason: 'Assumed Con Edison (NYC) from NYISO; confirm.' };
  return { code: null, reason: st ? `State ${st} is not an Atlas market.` : 'Market could not be determined from the ISO or address.' };
}

/** Best-effort utility match by name tokens (e.g. "SCE" → Southern California Edison). */
export function matchUtility(name, utilities) {
  if (!name) return null;
  const n = String(name).toUpperCase().replace(/[^A-Z0-9& ]/g, ' ');
  const alias = { SCE: 'SOUTHERN CALIFORNIA EDISON', 'SDG&E': 'SAN DIEGO', SDGE: 'SAN DIEGO', 'PG&E': 'PACIFIC GAS', PGE: 'PACIFIC GAS', CONED: 'CON EDISON', 'CON ED': 'CON EDISON', NGRID: 'NATIONAL GRID', CNP: 'CENTERPOINT', UI: 'UNITED ILLUMINATING', HECO: 'HAWAIIAN ELECTRIC', MECO: 'MAUI ELECTRIC', HELCO: 'HAWAII ELECTRIC LIGHT' };
  const target = Object.entries(alias).find(([k]) => n.split(/\s+/).includes(k) || n.includes(k))?.[1] || n;
  return utilities.find((u) => u.name.toUpperCase().includes(target.trim())) || utilities.find((u) => target.includes(u.name.toUpperCase().split(' (')[0])) || null;
}

/**
 * Map a workbench site model onto an Atlas site patch, plus notes and cross-checks for the user.
 * `interval` is the result of buildInterval (or null).
 */
export function siteFromWorkbench(model, interval, data) {
  const meta = model?.meta || {};
  const notes = [];
  const warnings = [];
  const patch = {};
  const name = [meta.customer, meta.site].filter(Boolean).join(' — ');
  if (name) patch.name = name;
  if (meta.site) patch.id = String(meta.site).replace(/[^\w-]+/g, '_').slice(0, 40);
  const mk = marketFor(meta);
  if (mk.code) patch.jurisdiction = mk.code;
  if (mk.reason) warnings.push(mk.reason);
  const jd = mk.code ? data.jurisdictions[mk.code] : null;
  const utilName = model?.tariffs?.lastImport?.utility || meta.utility || meta.iso;
  const util = jd ? matchUtility(utilName, jd.utilities) : null;
  if (util) {
    patch.utility_id = util.id;
    patch.tariff_id = null; // re-suggested from peak kW
    notes.push(`Utility: ${util.name}${model?.tariffs?.lastImport?.utility ? ' (from imported bills)' : ''}.`);
  } else if (jd) warnings.push(`Utility not identified from "${utilName || 'n/a'}" — pick it in step 1.`);
  const v = parseInt(meta.voltage, 10);
  if ([208, 240, 480].includes(v)) {
    patch.service_voltage = v;
    patch.phases = 3;
  }
  if (interval) {
    patch.peak_kw = Math.round(interval.peak_kw * 10) / 10;
    patch.annual_kwh = Math.round(interval.annual_kwh);
    patch.min_load_kw = Math.round(interval.p05_kw * 10) / 10;
    notes.push(`Interval data: ${interval.start} to ${interval.end} (${interval.days} days, ${interval.monthsCovered} months, ${Math.round(interval.dtHours * 60)}-min${interval.resampledFrom ? `, averaged from ${interval.resampledFrom}-min` : ''}). Peak ${patch.peak_kw} kW; annualized ${Math.round(patch.annual_kwh).toLocaleString('en-US')} kWh; minimum load (0.5th percentile) ${patch.min_load_kw} kW.`);
    if (interval.monthsCovered < 12) warnings.push(`Interval data covers ${interval.monthsCovered} of 12 months; missing months use the generic load shape.`);
  } else {
    const a = model?.analysis || {};
    if (a.peakKW) patch.peak_kw = Math.round(a.peakKW * 10) / 10;
    if (a.energyKWh) patch.annual_kwh = Math.round(a.energyKWh);
    warnings.push('No interval data in the file (raw block missing). Using the summary peak and energy with a generic load shape.');
  }
  // Bills: implied $/kW-month for a cross-check against the selected tariff.
  const bills = (model?.tariffs?.monthly || []).filter((r) => +r.billedKW > 0 && +r.demandUSD > 0);
  const billRate = bills.length ? bills.reduce((s, r) => s + +r.demandUSD, 0) / bills.reduce((s, r) => s + +r.billedKW, 0) : null;
  const sizing = model?.sizing || {};
  const selected = Array.isArray(sizing.mix) && sizing.mix.length ? sizing.mix.map((x) => `${x.n} × ${x.id}`).join(' + ') : sizing.unit ? `${sizing.nUnits || 1} × ${sizing.unit}` : null;
  return {
    patch,
    notes,
    warnings,
    workbench: {
      selected,
      selectedConfigId: workbenchConfigId(sizing),
      billRate,
      billMonths: bills.length,
      ratchetPct: typeof model?.tariffs?.ratchetPct === 'number' ? model.tariffs.ratchetPct : null,
      ercotTransRate: model?.tariffs?.ercot4cp?.transRateUSDperKW || null,
      drUsdPerKwYr: +model?.revenue?.drUSDperKWyr || null,
    },
  };
}

/** Atlas config id for the workbench's selected system, when every unit maps to an Atlas product. */
export function workbenchConfigId(sizing) {
  const items = Array.isArray(sizing?.mix) && sizing.mix.length ? sizing.mix : sizing?.unit ? [{ id: sizing.unit, n: sizing.nUnits || 1 }] : [];
  if (!items.length || !items.every((x) => WORKBENCH_UNIT_MAP[x.id])) return null;
  return items.map((x) => `${Math.max(1, Math.round(+x.n || 1))}x${WORKBENCH_UNIT_MAP[x.id]}`).join('+');
}

/**
 * The workbench file with Atlas results added under `atlas`. Every existing key — including `raw`
 * interval data — is preserved unchanged, so the file reopens in the workbench as before.
 */
export function mergeAtlasIntoWorkbench(original, atlasBlock) {
  const out = { ...(original || {}) };
  out.atlas = atlasBlock;
  if (!out.meta) out.meta = { customer: '', site: atlasBlock?.site?.name || '', branch: '', iso: '', addr: '', voltage: String(atlasBlock?.site?.service_voltage || '480'), mdp: '', unit: '30/150', crit: '', prep: '', date: new Date().toISOString().slice(0, 10) };
  return out;
}
