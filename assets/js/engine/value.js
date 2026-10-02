// Value-stack engine: turns a site + battery configuration + jurisdiction data into annual $ by stream.
// All results are indicative screening estimates. Every stream carries the inputs used so the export can
// feed an interval-data dispatch model.

import { designDayProfile, optimizeShave, windowMask } from './loadshape.js';

export const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** Program statuses counted in the base case; others go to the upside case or are excluded. */
const BASE_STATUSES = new Set(['open', 'pilot']);
const UPSIDE_STATUSES = new Set(['waitlist', 'pending_launch']);

export function usableKwh(config, a) {
  return config.kwh * a.usable_fraction;
}

/** kW a configuration can sustain for `hours` without exporting past site load during events. */
export function deliverableKw(config, site, a, hours) {
  const energyLimited = hours > 0 ? usableKwh(config, a) / hours : config.kw;
  const loadLimited = site.export_allowed ? Infinity : site.peak_kw * a.event_load_fraction;
  return Math.max(0, Math.min(config.kw, energyLimited, loadLimited));
}

/** Monthly-equivalent $/kW rate for a demand charge (daily charges × days in month). */
function monthlyRate(dc, month) {
  const r = dc.rate_usd_per_kw_month;
  if (typeof r !== 'number') return 0;
  return dc.basis === 'daily' ? r * DAYS_IN_MONTH[month - 1] : r;
}

/** Demand-charge reduction across the year, grouping months that share the same active components. */
export function demandChargeStreams(site, config, tariff, a, profile) {
  const charges = (tariff?.demand_charges || []).filter(
    (dc) => typeof dc.rate_usd_per_kw_month === 'number' && dc.rate_usd_per_kw_month > 0 && dc.basis !== 'coincident' && dc.basis !== 'contract',
  );
  if (!charges.length) return { streams: [], dailyEnergyKwh: 0 };
  const override = site.shave_kw_override?.[config.id];
  let dailyEnergyKwh = 0;
  const groups = new Map();
  for (const m of ALL_MONTHS) {
    const active = charges.map((dc, i) => ({ dc, i })).filter(({ dc }) => (dc.months?.length ? dc.months : ALL_MONTHS).includes(m));
    if (!active.length) continue;
    const key = active.map((x) => x.i).join(',');
    if (!groups.has(key)) groups.set(key, { active, months: [] });
    groups.get(key).months.push(m);
  }
  const totals = charges.map(() => ({ usd: 0, months: [], kwByMonth: {} }));
  for (const { active, months } of groups.values()) {
    const comps = active.map(({ dc, i }) => ({
      id: String(i),
      rate: monthlyRate(dc, months[0]),
      window: dc.window || null,
    }));
    const opt = optimizeShave(profile, comps, { kw: config.kw, usableKwh: usableKwh(config, a), rte: a.rte_ac });
    dailyEnergyKwh = Math.max(dailyEnergyKwh, opt.energyKwh);
    for (const { dc, i } of active) {
      const theoretical = opt.deltas[String(i)] || 0;
      const realized = override != null ? Math.min(Number(override), config.kw) : theoretical * a.shave_capture;
      for (const m of months) {
        totals[i].usd += monthlyRate(dc, m) * realized;
        totals[i].months.push(m);
        totals[i].kwByMonth[m] = realized;
      }
    }
  }
  const streams = charges.map((dc, i) => {
    const kws = Object.values(totals[i].kwByMonth);
    const avgKw = kws.length ? kws.reduce((s, x) => s + x, 0) / kws.length : 0;
    return {
      key: `demand:${i}`,
      category: 'demand_charge',
      label: `Demand charge — ${dc.label}`,
      annual_usd: totals[i].usd,
      upfront_usd: 0,
      scenario: 'base',
      confidence: dc.overridden ? 'user' : dc.confidence || tariff.confidence || 'medium',
      kw_used: avgKw,
      rate: dc.rate_usd_per_kw_month,
      unit: dc.basis === 'daily' ? '$/kW-day' : '$/kW-month',
      months: totals[i].months,
      basis_text:
        override != null
          ? `Override: ${fmt(avgKw)} kW reduction from your interval model × ${dc.rate_usd_per_kw_month} ${dc.basis === 'daily' ? '$/kW-day' : '$/kW-mo'} × ${totals[i].months.length} months`
          : `${fmt(avgKw)} kW avg reduction (design-day estimate × ${a.shave_capture} capture) × ${dc.rate_usd_per_kw_month} ${dc.basis === 'daily' ? '$/kW-day' : '$/kW-mo'} × ${totals[i].months.length} months`,
      source_id: tariff.id,
      notes: dc.notes || '',
      flags: dc.basis === 'ratchet' || tariff.ratchet ? ['ratchet'] : [],
    };
  });
  return { streams, dailyEnergyKwh };
}

/** Coincident-peak tag reductions (ICAP/PLC/NSPL/4CP/transmission). */
export function coincidentStreams(site, config, tariff, a) {
  if (!a.include_cp) return [];
  return (tariff?.coincident_peak_charges || [])
    .map((cp, i) => ({ cp, i }))
    .filter(({ cp }) => typeof cp.est_value_usd_per_kw_year === 'number' && cp.est_value_usd_per_kw_year > 0)
    .filter(({ cp }) => !(typeof cp.min_site_peak_kw === 'number' && site.peak_kw < cp.min_site_peak_kw))
    .map(({ cp, i }) => {
      const hours = cp.dispatch_hours || a.cp_dispatch_hours;
      const kw = deliverableKw(config, site, a, hours) * a.cp_hit_rate;
      const fixedSupply = site.supply_contract === 'fixed_all_in' && cp.passthrough !== 'delivery';
      const optional = !!cp.optional_election;
      return {
        key: `cp:${i}`,
        category: 'coincident_peak',
        label: `Peak-tag reduction — ${cpLabel(cp.type)}`,
        annual_usd: kw * cp.est_value_usd_per_kw_year,
        upfront_usd: 0,
        scenario: fixedSupply || optional ? 'upside' : 'base',
        cp_type: cp.type,
        confidence: cp.overridden ? 'user' : cp.confidence || tariff.confidence || 'medium',
        kw_used: kw,
        rate: cp.est_value_usd_per_kw_year,
        unit: '$/kW-yr',
        basis_text: `${fmt(kw)} kW (sustained ${hours} h × ${a.cp_hit_rate} hit rate) × $${cp.est_value_usd_per_kw_year}/kW-yr`,
        source_id: tariff.id,
        notes: [optional ? 'Optional rate election — counted in upside only.' : '', cp.how_set, cp.passthrough_notes].filter(Boolean).join(' '),
        flags: [fixedSupply ? 'fixed_supply_contract' : '', optional ? 'optional_election' : ''].filter(Boolean),
      };
    });
}

function cpLabel(type) {
  return (
    {
      capacity_tag: 'capacity tag (ICAP)',
      icap: 'capacity tag (ICAP)',
      plc: 'capacity PLC',
      nspl: 'transmission NSPL',
      transmission_tag: 'transmission tag',
      '4cp': 'ERCOT 4CP transmission',
    }[type] || type
  );
}

/** TOU energy arbitrage: discharge in the peak window, recharge off-peak (losses priced at off-peak). */
export function arbitrageStreams(site, config, tariff, a, profile) {
  const seasons = tariff?.arbitrage || [];
  return seasons
    .filter((s) => typeof s.peak_price === 'number' && typeof s.offpeak_price === 'number')
    .filter((s) => !s.requires_supply || s.requires_supply === site.supply_contract)
    .map((s, i) => {
      const win = s.peak_window || { start: 16, end: 21 };
      const mask = windowMask(profile.kw.length, profile.dtHours, win);
      const winHours = mask.filter(Boolean).length * profile.dtHours;
      // Energy the site can absorb in the window (non-export).
      let windowLoadKwh = 0;
      profile.kw.forEach((kw, idx) => {
        if (mask[idx]) windowLoadKwh += kw * profile.dtHours;
      });
      const eDis = Math.min(usableKwh(config, a), config.kw * winHours, site.export_allowed ? Infinity : windowLoadKwh);
      const perDay = Math.max(0, eDis * s.peak_price - (eDis / a.rte_ac) * s.offpeak_price);
      const months = s.months?.length ? s.months : ALL_MONTHS;
      const dayFrac = s.days === 'all' ? 1 : 5 / 7;
      const days = months.reduce((n, m) => n + DAYS_IN_MONTH[m - 1] * dayFrac, 0);
      return {
        key: `arb:${i}`,
        category: 'energy_arbitrage',
        label: `TOU energy shifting — ${s.label || 'season ' + (i + 1)}`,
        annual_usd: perDay * days * a.arbitrage_capture,
        upfront_usd: 0,
        scenario: 'base',
        confidence: tariff.confidence || 'medium',
        kw_used: eDis / winHours,
        rate: s.peak_price - s.offpeak_price,
        unit: '$/kWh spread',
        basis_text: `${fmt(eDis)} kWh/day × ($${s.peak_price} peak − $${s.offpeak_price}/${a.rte_ac} RTE off-peak) × ${Math.round(days)} days × ${a.arbitrage_capture} capture`,
        source_id: tariff.id,
        notes: s.notes || '',
        flags: [],
      };
    })
    .filter((s) => s.annual_usd > 0);
}

/** Program eligibility for a site/config. Returns {eligible, reason, viaAggregator}. */
export function programEligibility(program, site, config) {
  if (program.utility_ids?.length && !program.utility_ids.includes(site.utility_id)) {
    return { eligible: false, reason: 'Not offered in this utility territory' };
  }
  if (program.status === 'closed' || program.status === 'paused') {
    return { eligible: false, reason: `Program ${program.status}` };
  }
  const e = program.eligibility || {};
  if (e.requires_paired_solar && !site.has_solar) return { eligible: false, reason: 'Requires paired solar' };
  if (e.requires_disadvantaged_community && !site.disadvantaged_community) return { eligible: false, reason: 'Requires a disadvantaged-community / inclusive-eligible site' };
  if (e.requires_export && !site.export_allowed) return { eligible: false, reason: 'Requires export to the grid' };
  if (typeof e.max_kw === 'number' && config.kw > e.max_kw) return { eligible: false, reason: `Above program max ${e.max_kw} kW` };
  if (typeof e.max_kwh === 'number' && config.kwh > e.max_kwh) return { eligible: false, reason: `Above program max ${e.max_kwh} kWh` };
  if (typeof e.min_kwh === 'number' && config.kwh < e.min_kwh) return { eligible: false, reason: `Below program min ${e.min_kwh} kWh` };
  if (typeof e.min_kw === 'number' && config.kw < e.min_kw) {
    if (e.requires_aggregator_or_csp || e.aggregation_allowed) {
      return { eligible: true, viaAggregator: true, reason: `Below ${e.min_kw} kW minimum on its own — eligible only inside an aggregation` };
    }
    return { eligible: false, reason: `Below program min ${e.min_kw} kW` };
  }
  return { eligible: true, viaAggregator: !!e.requires_aggregator_or_csp };
}

/** Value of one program for a config. Returns a stream or null. */
export function programStream(program, site, config, a, ctx) {
  const v = program.valuation || {};
  if (typeof v.rate !== 'number' || v.method === 'text_only') return null;
  const elig = programEligibility(program, site, config);
  if (!elig.eligible) return null;
  const tier = (v.rate_by_site_peak_kw || []).find((t) => t.max_peak_kw == null || site.peak_kw <= t.max_peak_kw);
  const rate = site.program_rate_overrides?.[program.id] ?? tier?.rate ?? v.rate;
  const dispatchCats = ['demand_response', 'performance_incentive', 'wholesale_market'];
  const assumedHours = !v.duration_basis_hr && !program.dispatch?.event_duration_hr && dispatchCats.includes(program.category) && !v.method?.startsWith('upfront');
  const hours = v.duration_basis_hr || program.dispatch?.event_duration_hr || (assumedHours ? a.default_dr_event_hours || 0 : 0);
  const dk = deliverableKw(config, site, a, hours);
  const perf = program.category === 'demand_response' || program.category === 'performance_incentive' || program.category === 'wholesale_market' ? a.dr_performance : 1;
  let annual = 0;
  let upfront = 0;
  let basis = '';
  // Incentive basis may be capped below the eligibility limit (e.g. "paid on the first 1,000 kWh").
  const kwhBasis = typeof v.max_kwh_incentivized === 'number' ? Math.min(config.kwh, v.max_kwh_incentivized) : config.kwh;
  const kwBasis = typeof v.max_kw_incentivized === 'number' ? Math.min(config.kw, v.max_kw_incentivized) : config.kw;
  switch (v.method) {
    case 'per_kw_season': {
      const seasons = v.seasons_per_year || 1;
      annual = rate * dk * perf * seasons;
      basis = `${fmt(dk)} kW deliverable over ${hours || '—'} h × ${perf} performance × $${rate}/kW-season${seasons > 1 ? ` × ${seasons} seasons` : ''}`;
      break;
    }
    case 'per_kw_month': {
      const months = v.months_per_year || 12;
      annual = rate * dk * perf * months;
      basis = `${fmt(dk)} kW × ${perf} perf × $${rate}/kW-mo × ${months} months`;
      break;
    }
    case 'per_kw_year':
      annual = rate * dk * perf;
      basis = `${fmt(dk)} kW × ${perf} perf × $${rate}/kW-yr`;
      break;
    case 'per_kwh_event': {
      const evh = v.expected_event_hours_per_year || 0;
      annual = rate * dk * perf * evh;
      basis = `${fmt(dk)} kW × ${perf} perf × ${evh} event-h/yr × $${rate}/kWh`;
      break;
    }
    case 'per_mwh': {
      const evh = v.expected_event_hours_per_year || 0;
      annual = (rate / 1000) * dk * perf * evh;
      basis = `${fmt(dk)} kW × ${evh} h/yr × $${rate}/MWh`;
      break;
    }
    case 'upfront_per_kwh': {
      upfront = rate * kwhBasis;
      basis = `${fmt(kwhBasis)} kWh × $${rate}/kWh`;
      break;
    }
    case 'upfront_per_kw': {
      upfront = rate * kwBasis;
      basis = `${fmt(kwBasis)} kW × $${rate}/kW`;
      break;
    }
    case 'pct_of_cost': {
      if (config.installedCostUsd == null) return null;
      const basisCost = Math.max(0, config.installedCostUsd - (a.incentives_reduce_itc_basis ? ctx.otherUpfront || 0 : 0));
      upfront = rate * basisCost;
      basis = `${(rate * 100).toFixed(0)}% × $${fmt(basisCost)} eligible cost`;
      break;
    }
    default:
      return null;
  }
  // Caps expressed as fraction of project cost.
  if (upfront > 0 && typeof v.cap_pct_of_cost === 'number' && config.installedCostUsd != null) {
    const cap = v.cap_pct_of_cost * config.installedCostUsd;
    if (upfront > cap) {
      upfront = cap;
      basis += ` (capped at ${(v.cap_pct_of_cost * 100).toFixed(0)}% of cost)`;
    }
  }
  if (upfront > 0 && typeof v.cap_usd === 'number' && upfront > v.cap_usd) {
    upfront = v.cap_usd;
    basis += ` (capped at $${fmt(v.cap_usd)})`;
  }
  const scenario = BASE_STATUSES.has(program.status) ? 'base' : UPSIDE_STATUSES.has(program.status) ? 'upside' : 'base';
  const flags = [];
  if (elig.viaAggregator) flags.push('aggregator_required');
  if (hours && config.durationHr < hours) flags.push('duration_short');
  if (assumedHours && hours) flags.push('duration_assumed');
  return {
    key: `prog:${program.id}`,
    category: program.category,
    label: program.name,
    program_id: program.id,
    annual_usd: annual,
    upfront_usd: upfront,
    scenario,
    confidence: program.confidence || 'medium',
    kw_used: dk,
    rate,
    unit: v.unit || v.method,
    basis_text: basis,
    source_id: program.id,
    term_years: v.term_years || null,
    schedule: v.schedule || null,
    notes: [elig.reason, tier?.label ? `Rate tier: ${tier.label}` : ''].filter(Boolean).join(' '),
    flags,
    conflicts_with: program.stacking?.conflicts_with || [],
  };
}

/**
 * Resolve mutually exclusive programs: keep the highest-value one in each conflict set.
 * Conflicts may reference program ids or stream categories.
 */
export function resolveConflicts(streams) {
  const ordered = streams.slice().sort((x, y) => totalWorth(y) - totalWorth(x));
  const kept = [];
  const excluded = [];
  for (const s of ordered) {
    const clash = kept.find(
      (k) =>
        (s.conflicts_with || []).includes(k.program_id) ||
        (k.conflicts_with || []).includes(s.program_id) ||
        (s.conflicts_with || []).includes(k.category),
    );
    if (clash && s.program_id) excluded.push({ ...s, excluded_by: clash.program_id || clash.key });
    else kept.push(s);
  }
  return { kept, excluded };
}

const totalWorth = (s) => s.annual_usd * 5 + s.upfront_usd;

/** Energy cost of round-trip losses when cycling for demand management on a flat energy price. */
export function cyclingLossStream(site, config, a, shaveEnergyKwh, hasArbitrage) {
  if (hasArbitrage || !(shaveEnergyKwh > 0) || !(site.energy_price > 0)) return null;
  const days = a.shave_days_per_year;
  const loss = shaveEnergyKwh * (1 / a.rte_ac - 1) * site.energy_price * days;
  return {
    key: 'losses',
    category: 'cost',
    label: 'Round-trip losses (cycling for demand management)',
    annual_usd: -loss,
    upfront_usd: 0,
    scenario: 'base',
    confidence: 'medium',
    kw_used: 0,
    rate: site.energy_price,
    unit: '$/kWh',
    basis_text: `${fmt(shaveEnergyKwh)} kWh/day × (1/${a.rte_ac} − 1) × $${site.energy_price}/kWh × ${days} days`,
    notes: '',
    flags: [],
  };
}

/** Full value stack for one configuration. */
export function valueStack(site, config, ctx) {
  const { tariff, programs, assumptions: a } = ctx;
  const profile =
    ctx.profile ||
    designDayProfile({ peakKw: site.peak_kw, annualKwh: site.annual_kwh, buildingType: site.building_type, custom: site.custom_profile });
  const { streams: demand, dailyEnergyKwh } = demandChargeStreams(site, config, tariff, a, profile);
  const cp = coincidentStreams(site, config, tariff, a);
  const arb = arbitrageStreams(site, config, tariff, a, profile);

  // Upfront (non-tax) incentives first, so the ITC basis can net them out.
  const progStreams = [];
  const taxPrograms = [];
  for (const p of programs) {
    if (p.valuation?.method === 'pct_of_cost') {
      taxPrograms.push(p);
      continue;
    }
    const s = programStream(p, site, config, a, ctx);
    if (s) progStreams.push(s);
  }
  const { kept, excluded } = resolveConflicts(progStreams);
  const otherUpfront = kept.filter((s) => s.scenario === 'base').reduce((n, s) => n + s.upfront_usd, 0);
  const tax = taxPrograms.map((p) => programStream(p, site, config, a, { ...ctx, otherUpfront })).filter(Boolean);

  const loss = cyclingLossStream(site, config, a, dailyEnergyKwh, arb.length > 0);
  // Programs that pay for the same kW as a peak-tag reduction (e.g. PJM capacity DR vs. PLC): keep the larger.
  let cpKept = cp;
  const progKept = [];
  for (const p of kept) {
    const types = (p.conflicts_with || []).filter((c) => c.startsWith('cp:')).map((c) => c.slice(3));
    if (!types.length) {
      progKept.push(p);
      continue;
    }
    const clash = cpKept.filter((s) => types.includes(s.cp_type) || types.includes('*'));
    const clashUsd = clash.reduce((n, s) => n + s.annual_usd, 0);
    if (clash.length && clashUsd >= p.annual_usd) excluded.push({ ...p, excluded_by: clash.map((s) => s.label).join(', ') });
    else {
      clash.forEach((s) => excluded.push({ ...s, excluded_by: p.program_id }));
      cpKept = cpKept.filter((s) => !clash.includes(s));
      progKept.push(p);
    }
  }
  const nonZero = (s) => Math.abs(s.annual_usd) > 0.5 || Math.abs(s.upfront_usd) > 0.5;
  const streams = [...demand, ...cpKept, ...arb, ...progKept, ...tax, ...(loss ? [loss] : [])].filter(nonZero);

  const sum = (pred, field) => streams.filter(pred).reduce((n, s) => n + s[field], 0);
  const isBase = (s) => s.scenario === 'base';
  const totals = {
    annual_base: sum(isBase, 'annual_usd'),
    annual_upside: sum(() => true, 'annual_usd'),
    upfront_base: sum(isBase, 'upfront_usd'),
    upfront_upside: sum(() => true, 'upfront_usd'),
  };
  return { config, profile, streams, excluded, totals };
}


export function fmt(x) {
  if (x == null || Number.isNaN(x)) return '—';
  const abs = Math.abs(x);
  return abs >= 100 ? Math.round(x).toLocaleString('en-US') : abs >= 10 ? x.toFixed(1) : x.toFixed(2);
}
