// Engine entry point: analyze one site end-to-end.

import { designDayProfile } from './loadshape.js';
import { candidateConfigs, buildConfig } from './configs.js';
import { valueStack, programEligibility, chargeAppliesToSite } from './value.js';
import { siteLimits, checkConfig, SEVERITY_ORDER } from './constraints.js';
import { economics, yearlyValues } from './finance.js';
import { siteScore } from './score.js';
import { panelReview, briefingNotes } from './panel.js';

export { buildConfig } from './configs.js';
export { BUILDING_SHAPES, loadFactor } from './loadshape.js';

/** Merge defaults from data with user settings. */
export function resolveAssumptions(data, settings = {}) {
  const defaults = Object.fromEntries((data.global?.assumptions || []).map((x) => [x.key, x.value]));
  return { ...defaults, ...(settings.assumptions || {}) };
}

/** Programs that can apply to a site: the jurisdiction's own plus federal/global ones. */
export function programsForSite(site, data) {
  const j = data.jurisdictions[site.jurisdiction];
  return [...(j?.programs || []), ...(data.global?.programs || [])].filter((p) => !p.utility_ids?.length || p.utility_ids.includes(site.utility_id));
}

/**
 * @param site     site inputs (see docs/METHODOLOGY.md)
 * @param data     { products, global, panel, jurisdictions: {code: jurisdictionData} }
 * @param settings { assumptions?, products? }
 * @param extras   { interval? } — per-month interval data from a workbench site file (workbench.js buildInterval)
 */
export function analyzeSite(site, data, settings = {}, extras = {}) {
  const jurisdiction = data.jurisdictions[site.jurisdiction];
  if (!jurisdiction) throw new Error(`Unknown jurisdiction ${site.jurisdiction}`);
  const tariff = applyTariffOverrides((jurisdiction.tariffs || []).find((t) => t.id === site.tariff_id) || null, site.tariff_overrides);
  const assumptions = resolveAssumptions(data, settings);
  const products = settings.products || data.products;
  const programs = programsForSite(site, data);
  const profile = designDayProfile({ peakKw: site.peak_kw, annualKwh: site.annual_kwh, buildingType: site.building_type, custom: site.custom_profile });
  const interval = extras.interval || null;
  const ctx = { site, jurisdiction, global: data.global, panel: data.panel, products, assumptions, tariff, programs, profile, interval };
  const limits = siteLimits(site, ctx, profile);

  const configs = site.custom_configs?.length
    ? site.custom_configs.map((items) => buildConfig(items, products))
    : candidateConfigs(products, { usefulKwCeiling: Math.max(limits.usefulKwCeiling ?? site.peak_kw, 1), maxUnitsPerProduct: site.max_units_per_product || 8 });

  const results = configs.map((config) => {
    const vs = valueStack(site, config, ctx);
    const constraints = checkConfig(site, config, ctx, limits);
    const omPerYear = (assumptions.om_usd_per_kw_yr || 0) * config.kw + ((assumptions.om_pct_capex || 0) / 100) * (config.installedCostUsd || 0);
    const yOpts = { years: assumptions.analysis_years, degradationPct: assumptions.degradation_pct_yr, escalationPct: assumptions.escalation_pct_yr, postTermFactor: assumptions.post_term_value_factor ?? 1 };
    const common = { capex: config.installedCostUsd, omPerYear, discountRate: assumptions.discount_rate_pct / 100 };
    return {
      ...vs,
      constraints,
      omPerYear,
      finance: {
        base: economics({ ...common, upfront: vs.totals.upfront_base, yearly: yearlyValues(vs.streams, { ...yOpts, scenario: 'base' }) }),
        upside: economics({ ...common, upfront: vs.totals.upfront_upside, yearly: yearlyValues(vs.streams, { ...yOpts, scenario: 'upside' }) }),
      },
    };
  });

  const feasible = results.filter((r) => r.constraints.status !== 'critical');
  const pool = feasible.length ? feasible : results;
  const recommended = pickRecommended(pool);
  const analysis = { site, tariff, jurisdiction, limits, profile, results, recommended, assumptions };
  analysis.interval = interval
    ? { start: interval.start, end: interval.end, days: interval.days, monthsCovered: interval.monthsCovered, peak_kw: interval.peak_kw, annual_kwh: interval.annual_kwh, p05_kw: interval.p05_kw, dt_min: Math.round(interval.dtHours * 60) }
    : null;
  analysis.missing = missingRates(tariff, site);
  analysis.score = siteScore(recommended, { incomplete: analysis.missing.length > 0 });
  analysis.panel = panelReview(site, analysis, ctx);
  analysis.briefing = briefingNotes(site, jurisdiction, data.panel);
  analysis.programs = programs.map((p) => ({ program: p, ...(recommended ? programEligibility(p, site, recommended.config) : { eligible: false }) }));
  return analysis;
}

/**
 * Apply user-entered rates (e.g. read off the customer's bill) on top of the database tariff.
 * overrides = { demand: {index: $/kW-month}, cp: {index: $/kW-yr} }
 */
export function applyTariffOverrides(tariff, overrides) {
  if (!tariff || !overrides) return tariff;
  const t = JSON.parse(JSON.stringify(tariff));
  const valid = (v) => v !== '' && v != null && Number.isFinite(Number(v));
  for (const [i, v] of Object.entries(overrides.demand || {})) {
    if (t.demand_charges?.[i] && valid(v)) Object.assign(t.demand_charges[i], { rate_usd_per_kw_month: Number(v), overridden: true });
  }
  for (const [i, v] of Object.entries(overrides.cp || {})) {
    if (t.coincident_peak_charges?.[i] && valid(v)) Object.assign(t.coincident_peak_charges[i], { est_value_usd_per_kw_year: Number(v), overridden: true });
  }
  return t;
}

/** Highest NPV when costs are known; otherwise highest base annual value per installed kWh × size tiebreak. */
function pickRecommended(results) {
  if (!results.length) return null;
  const withNpv = results.filter((r) => r.finance.base.npv != null);
  if (withNpv.length) {
    return withNpv.reduce((best, r) => (r.finance.base.npv > best.finance.base.npv ? r : best));
  }
  return results.reduce((best, r) => (r.totals.annual_base > best.totals.annual_base ? r : best));
}

/** Tariff elements that apply to this site but have no rate: their savings are excluded, not zero. */
export function missingRates(tariff, site) {
  if (!tariff) return ['tariff'];
  const out = [];
  for (const dc of tariff.demand_charges || []) {
    if (dc.basis === 'contract' || dc.basis === 'coincident') continue;
    if (!chargeAppliesToSite(dc, site)) continue;
    if (typeof dc.rate_usd_per_kw_month !== 'number') out.push(dc.label);
  }
  for (const cp of tariff.coincident_peak_charges || []) {
    if (!chargeAppliesToSite(cp, site)) continue;
    if (typeof cp.est_value_usd_per_kw_year !== 'number') out.push(`peak tag: ${cp.type}`);
  }
  return out;
}

export function worstSeverity(checks) {
  return checks.reduce((s, c) => (SEVERITY_ORDER[c.severity] > SEVERITY_ORDER[s] ? c.severity : s), 'ok');
}
