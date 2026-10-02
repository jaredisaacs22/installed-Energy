// Synthetic workbench <site>-site.json for tests — NOT real site data.
// The `raw` block uses the workbench's own encoding (edEncodeRaw): wall-clock "lm" integers,
// delta + run-length encoded timestamps, kW rounded to 4 decimals.

const lmOf = (y, mo, d, h, mi) => ((((y * 12 + mo) * 31 + (d - 1)) * 1440) + h * 60 + mi);

function encodeRaw(stamps, kw, dt) {
  const runs = [];
  let prev = stamps[0];
  let cur = null;
  let cnt = 0;
  for (let i = 1; i < stamps.length; i++) {
    const dv = stamps[i] - prev;
    prev = stamps[i];
    if (cur === null) {
      cur = dv;
      cnt = 1;
    } else if (dv === cur) cnt++;
    else {
      runs.push([cnt, cur]);
      cur = dv;
      cnt = 1;
    }
  }
  if (cur !== null) runs.push([cnt, cur]);
  return { v: 1, n: stamps.length, dt, b: stamps[0], r: runs, kw: kw.map((x) => Math.round(x * 1e4) / 1e4) };
}

/** Deterministic pseudo-random generator so fixtures are stable across runs. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * A year (2025) of 15-minute data for a retail store: base load overnight, a broad daytime plateau,
 * a summer afternoon peak, weekends lower, plus noise and a few spiky days.
 */
export function makeWorkbenchSite({ peakKw = 300, seed = 7, site = 'Test Store', addr = 'Boston, MA 02110', iso = 'ISO-NE', utility = null, spikes = true } = {}) {
  const rand = rng(seed);
  const stamps = [];
  const kw = [];
  const start = Date.UTC(2025, 0, 1);
  for (let day = 0; day < 365; day++) {
    const dte = new Date(start + day * 864e5);
    const y = dte.getUTCFullYear();
    const mo = dte.getUTCMonth();
    const d = dte.getUTCDate();
    const wd = dte.getUTCDay();
    const summer = mo >= 5 && mo <= 8 ? 1 : 0;
    const weekend = wd === 0 || wd === 6;
    const spikeDay = spikes && rand() < 0.04;
    for (let slot = 0; slot < 96; slot++) {
      const h = slot / 4;
      let f = 0.32; // overnight base
      if (h >= 7 && h < 21) f = 0.7 + 0.12 * Math.sin(((h - 7) / 14) * Math.PI);
      if (summer && h >= 12 && h < 18) f += 0.16 * Math.sin(((h - 12) / 6) * Math.PI);
      if (weekend) f *= 0.82;
      if (spikeDay && h >= 13 && h < 14.5) f += 0.12;
      f *= 1 + (rand() - 0.5) * 0.06;
      stamps.push(lmOf(y, mo, d, Math.floor(h), (slot % 4) * 15));
      kw.push(f * peakKw * 0.92);
    }
  }
  const model = {
    meta: { customer: 'Example Customer', site, branch: '', iso, addr, voltage: '480', mdp: 'MDP-1', unit: '65/200', crit: '', prep: '', date: '2026-10-02' },
    components: [],
    connections: [],
    photos: [],
    _seq: 1,
    // Summary left for the workbench to re-derive from `raw` on open (it does this whenever peakKW is null).
    analysis: { source: 'synthetic.csv', rows: 0, intervalMin: 15, valueType: 'kW', cols: { dt: 0, val: 1 }, peakKW: null, monthly: [], daily: [] },
    tariffs: {
      mode: 'peak-shave',
      ratchetPct: 0.7,
      demandRate: null,
      monthly: Array.from({ length: 12 }, (_, m) => ({ m, billedKW: Math.round(peakKw * 0.9), demandUSD: Math.round(peakKw * 0.9 * 18) })),
      lastImport: utility ? { utility, utilityHow: 'test' } : null,
    },
    sizing: { unit: '65/200', nUnits: 1, mix: [], monthAchievable: null, sweep: [], monthlyTargets: null },
    someSiblingToolKey: { keep: true },
    raw: encodeRaw(stamps, kw, 15),
  };
  return model;
}
