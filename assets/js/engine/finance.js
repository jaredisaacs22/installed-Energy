// Indicative project economics. Screening-grade only: no taxes on savings, no financing structure.

/**
 * @param {object} p
 * @param {number|null} p.capex           installed cost ($)
 * @param {number} p.upfront              one-time incentives incl. ITC ($)
 * @param {number} p.annual               year-1 net annual value ($)
 * @param {number} p.omPerYear            year-1 O&M ($)
 * @param {number} p.degradation          fractional annual decline in value (e.g. 0.02)
 * @param {number} p.escalation           annual escalation of tariff-based value (e.g. 0.02)
 * @param {number} p.discountRate         e.g. 0.08
 * @param {number} p.years                analysis horizon
 */
export function economics({ capex, upfront = 0, annual = 0, yearly = null, omPerYear = 0, degradation = 0.02, escalation = 0, discountRate = 0.08, years = 10 }) {
  if (capex == null) {
    return { netCost: null, simplePayback: null, npv: null, irr: null, cashflows: null };
  }
  const netCost = capex - upfront;
  const cashflows = [-netCost];
  const n = yearly ? yearly.length : years;
  for (let t = 1; t <= n; t++) {
    const value = yearly ? yearly[t - 1] : annual * Math.pow(1 - degradation, t - 1) * Math.pow(1 + escalation, t - 1);
    cashflows.push(value - omPerYear * Math.pow(1.025, t - 1));
  }
  const npv = cashflows.reduce((s, cf, t) => s + cf / Math.pow(1 + discountRate, t), 0);
  const yr1Net = cashflows[1];
  const simplePayback = netCost <= 0 ? 0 : yr1Net > 0 ? netCost / yr1Net : null;
  return { netCost, simplePayback, npv, irr: irr(cashflows), cashflows };
}

/**
 * Year-by-year value of a set of streams: degradation applies to everything, tariff escalation only to
 * bill-based streams, and program schedules (e.g. a step-down in years 6–10, or a program term) override.
 */
const TARIFF_BASED = new Set(['demand_charge', 'coincident_peak', 'energy_arbitrage', 'cost']);
export function yearlyValues(streams, { scenario = 'base', years = 10, degradationPct = 2, escalationPct = 0, postTermFactor = 1 } = {}) {
  const out = [];
  for (let t = 1; t <= years; t++) {
    let v = 0;
    for (const s of streams) {
      if (scenario === 'base' && s.scenario !== 'base') continue;
      if (!s.annual_usd) continue;
      let m = s.no_degradation ? 1 : Math.pow(1 - degradationPct / 100, t - 1);
      if (TARIFF_BASED.has(s.category)) m *= Math.pow(1 + escalationPct / 100, t - 1);
      if (s.schedule?.length) {
        const seg = s.schedule.find((x) => t >= x.start_year && t <= x.end_year);
        m *= !seg ? 0 : seg.rate != null && s.rate ? seg.rate / s.rate : seg.factor ?? 1;
      } else if (s.term_years && t > s.term_years) {
        // After a program's rate lock / term ends, the rate is uncertain.
        m *= postTermFactor;
      }
      v += s.annual_usd * m;
    }
    out.push(v);
  }
  return out;
}

/** IRR by bisection; null if no sign change. */
export function irr(cashflows) {
  const f = (r) => cashflows.reduce((s, cf, t) => s + cf / Math.pow(1 + r, t), 0);
  let lo = -0.99;
  let hi = 1.5;
  let flo = f(lo);
  const fhi = f(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 1e-7) return mid;
    if (fm * flo > 0) {
      lo = mid;
      flo = fm;
    } else hi = mid;
  }
  return (lo + hi) / 2;
}
