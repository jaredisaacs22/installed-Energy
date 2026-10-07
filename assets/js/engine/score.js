// Site attractiveness score (0–100) for ranking candidate sites. Transparent and deliberately simple:
//   economics (50%)   – simple payback of the recommended config: ≤4 yr → 100, ≥12 yr → 0 (linear),
//                       capped at 40 when NPV over the analysis horizon is negative
//                       or, without cost data (or while costs are placeholders), value density
//                       $/kWh-yr: ≥$120 → 100, ≤$20 → 0
//   certainty (20%)   – share of value from base-case, medium/high-confidence streams
//   feasibility (30%) – 100 minus penalties: critical −45, caution −12, info −2 (per check, capped at 0)

const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

export function siteScore(rec, { incomplete = false, costsKnown = true } = {}) {
  if (!rec) return { score: 0, grade: 'F', parts: { economics: 0, certainty: 0, feasibility: 0 }, basis: 'No feasible configuration' };
  const fin = rec.finance.base;
  let economics;
  let basis;
  if (!costsKnown) {
    const density = rec.config.kwh > 0 ? rec.totals.annual_base / rec.config.kwh : 0;
    economics = clamp(((density - 20) / 100) * 100);
    basis = `$${density.toFixed(0)}/kWh-yr of battery`;
  } else if (fin.netCost != null && fin.simplePayback == null) {
    economics = 0;
    basis = 'does not pay back (year-1 net value ≤ 0)';
  } else if (fin.simplePayback != null) {
    economics = clamp(((12 - fin.simplePayback) / 8) * 100);
    basis = `payback ${fin.simplePayback.toFixed(1)} yr`;
    // A negative NPV over the analysis horizon caps the economics score.
    if (fin.npv != null && fin.npv < 0) {
      economics = Math.min(economics, 40);
      basis += ', NPV < 0';
    }
  } else {
    const density = rec.config.kwh > 0 ? rec.totals.annual_base / rec.config.kwh : 0;
    economics = clamp(((density - 20) / 100) * 100);
    basis = `$${density.toFixed(0)}/kWh-yr value density (no cost data)`;
  }
  const worth = (s) => Math.max(0, s.annual_usd) + Math.max(0, s.upfront_usd) / 5;
  const total = rec.streams.reduce((n, s) => n + worth(s), 0);
  const solid = rec.streams.filter((s) => s.scenario === 'base' && s.confidence !== 'low').reduce((n, s) => n + worth(s), 0);
  const certainty = total > 0 ? (100 * solid) / total : 0;
  const penalty = rec.constraints.checks.reduce((n, c) => n + ({ critical: 45, caution: 12, info: 2 }[c.severity] || 0), 0);
  const feasibility = clamp(100 - penalty);
  const score = Math.round(0.5 * economics + 0.2 * certainty + 0.3 * feasibility);
  const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';
  return { score, grade, incomplete, parts: { economics: Math.round(economics), certainty: Math.round(certainty), feasibility: Math.round(feasibility) }, basis: incomplete ? `${basis}; rates missing — incomplete` : basis };
}
