// Value-stack engine: turns a site + battery configuration + jurisdiction data into annual $ by stream.
// All results are indicative screening estimates. Every stream carries the inputs used so the export can
// feed an interval-data dispatch model.

import { designDayProfile, optimizeShave, windowMask, eventDayReduction } from './loadshape.js';

export const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const DISPATCH_CATEGORIES = new Set(['demand_response', 'performance_incentive', 'wholesale_market']);

/** Program statuses counted in the base case; any other non-closed status counts only in upside. */
const BASE_STATUSES = new Set(['open', 'pilot']);

export function usableKwh(config, a) {
  return config.kwh * a.usable_fraction;
}

/**
 * kW a configuration can sustain for `hours`. Unless the value stream pays for export, discharge is also
 * capped at site load during events (non-export, and peak tags / DR baselines never credit export).
 */
export function deliverableKw(config, site, a, hours, { capAtLoad = !site.export_allowed } = {}) {
  const energyLimited = hours > 0 ? usableKwh(config, a) / hours : config.kw;
  const loadLimited = capAtLoad ? site.peak_kw * a.event_load_fraction : Infinity;
  return Math.max(0, Math.min(config.kw, energyLimited, loadLimited));
}

/** Monthly-equivalent $/kW rate for a demand charge (daily charges × days in month). */
function monthlyRate(dc, month) {
  const r = dc.rate_usd_per_kw_month;
  if (typeof r !== 'number') return 0;
  return dc.basis === 'daily' ? r * DAYS_IN_MONTH[month - 1] : r;
}

/** Charges that apply to this site size (e.g. non-IDR transmission only below 700 kW). */
export function chargeAppliesToSite(item, site) {
  if (typeof item.max_site_peak_kw === 'number' && site.peak_kw > item.max_site_peak_kw) return false;
  if (typeof item.min_site_peak_kw === 'number' && site.peak_kw < item.min_site_peak_kw) return false;
  return true;
}

/**
 * Demand-charge reduction across the year. Months are grouped by the set of active charges and by which
 * dispatch programs call events that month. On event days the battery's energy goes to the event, so the
 * month's reduction is the lesser of a normal day's optimized shave and the event day's incidental shave.
 *
 * events: [{ program_id, months, block: {start,end}, kw }]
 * Returns { streams, dailyEnergyKwh, cyclingKwhPerYear, monthOpt: {month: optimizer result} }.
 */
export function demandChargeStreams(site, config, tariff, a, profile, events = []) {
  const charges = (tariff?.demand_charges || [])
    .map((dc, idx) => ({ dc, idx }))
    .filter(({ dc }) => typeof dc.rate_usd_per_kw_month === 'number' && dc.rate_usd_per_kw_month > 0 && dc.basis !== 'coincident' && dc.basis !== 'contract' && chargeAppliesToSite(dc, site));
  if (!charges.length) return { streams: [], dailyEnergyKwh: 0, cyclingKwhPerYear: 0, monthOpt: {} };
  const override = site.shave_kw_override?.[config.id];
  const ratchetPeakMonths = a.ratchet_peak_months || [6, 7, 8, 9];
  let dailyEnergyKwh = 0;
  let cyclingKwhPerYear = 0;
  const monthOpt = {};
  const groups = new Map();
  for (const m of ALL_MONTHS) {
    const active = charges.map((c, i) => ({ ...c, i })).filter(({ dc }) => (dc.months?.length ? dc.months : ALL_MONTHS).includes(m));
    if (!active.length) continue;
    const evs = events.filter((e) => e.months.includes(m));
    const key = `${active.map((x) => x.i).join(',')}|${evs.map((e) => e.program_id).join(',')}`;
    if (!groups.has(key)) groups.set(key, { active, evs, months: [] });
    groups.get(key).months.push(m);
  }
  const totals = charges.map(() => ({ usd: 0, months: [], kwByMonth: {}, eventLimited: false }));
  for (const { active, evs, months } of groups.values()) {
    const comps = active.map(({ dc, i }) => ({ id: String(i), rate: monthlyRate(dc, months[0]), window: dc.window || null }));
    const energyCostPerKwhMonth = site.energy_price > 0 ? (1 / a.rte_ac - 1) * site.energy_price * ((a.shave_days_per_year || 250) / 12) : 0;
    const opt = optimizeShave(profile, comps, { kw: config.kw, usableKwh: usableKwh(config, a), rte: a.rte_ac, energyCostPerKwhMonth });
    dailyEnergyKwh = Math.max(dailyEnergyKwh, opt.energyKwh);
    months.forEach((m) => (monthOpt[m] = opt));
    const eventRed = evs.map((e) => eventDayReduction(profile, comps, e.block, e.kw));
    let optValue = 0;
    let realizedValue = 0;
    for (const { dc, i } of active) {
      let theoretical = opt.deltas[String(i)] || 0;
      for (const er of eventRed) {
        if (er[String(i)] < theoretical) {
          theoretical = er[String(i)];
          totals[i].eventLimited = true;
        }
      }
      const realized = override != null ? Math.min(Number(override), config.kw) : theoretical * a.shave_capture;
      optValue += monthlyRate(dc, months[0]) * (opt.deltas[String(i)] || 0);
      realizedValue += monthlyRate(dc, months[0]) * (override != null ? realized : theoretical);
      const ratchetPct = dc.basis === 'ratchet' && typeof tariff.ratchet?.pct === 'number' ? tariff.ratchet.pct : null;
      for (const m of months) {
        // With a ratchet, off-season billing demand is set by pct × the annual peak, so a kW shaved off the
        // annual peak is worth only pct in those months.
        const f = ratchetPct != null && !ratchetPeakMonths.includes(m) ? ratchetPct : 1;
        totals[i].usd += monthlyRate(dc, m) * realized * f;
        totals[i].months.push(m);
        totals[i].kwByMonth[m] = realized;
      }
    }
    // Cycle only as much as the realized saving justifies (no shaving on days that can't lower the bill).
    const useFrac = optValue > 0 ? Math.min(1, realizedValue / optValue) : 0;
    cyclingKwhPerYear += opt.energyKwh * useFrac * (a.shave_days_per_year || 250) * (months.length / 12);
  }
  const streams = charges.map(({ dc, idx }, i) => {
    const kws = Object.values(totals[i].kwByMonth);
    const avgKw = kws.length ? kws.reduce((s, x) => s + x, 0) / kws.length : 0;
    const unit = dc.basis === 'daily' ? '$/kW-day' : '$/kW-mo';
    const ratchet = dc.basis === 'ratchet' && typeof tariff.ratchet?.pct === 'number';
    return {
      key: `demand:${idx}`,
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
        (override != null
          ? `Override: ${fmt(avgKw)} kW reduction from your interval model × ${dc.rate_usd_per_kw_month} ${unit} × ${totals[i].months.length} months`
          : `${fmt(avgKw)} kW avg reduction (design-day estimate × ${a.shave_capture} capture) × ${dc.rate_usd_per_kw_month} ${unit} × ${totals[i].months.length} months`) +
        (ratchet ? `; off-season months at ${tariff.ratchet.pct} (ratchet)` : ''),
      source_id: tariff.id,
      notes: [dc.notes, totals[i].eventLimited ? 'Limited by DR/performance event days, when the battery’s energy goes to the event.' : ''].filter(Boolean).join(' '),
      flags: [ratchet || tariff.ratchet ? 'ratchet' : '', totals[i].eventLimited ? 'event_days_limit_shave' : ''].filter(Boolean),
    };
  });
  return { streams, dailyEnergyKwh, cyclingKwhPerYear, monthOpt };
}

/** Whether a peak-tag saving reaches the customer under their supply arrangement. */
function tagPassThrough(cp, site) {
  if (cp.passthrough === 'delivery') return { base: true };
  const c = site.supply_contract;
  if (c === 'passthrough' || c === 'index') return { base: true };
  if (c === 'default_service') return cp.default_service_passthrough ? { base: true } : { base: false, flag: 'default_service_no_tags' };
  if (c === 'fixed_all_in') return { base: false, flag: 'fixed_supply_contract' };
  return { base: false, flag: 'supply_unknown' };
}

/** Coincident-peak tag reductions (ICAP/PLC/NSPL/4CP/transmission). */
export function coincidentStreams(site, config, tariff, a) {
  if (!a.include_cp) return [];
  return (tariff?.coincident_peak_charges || [])
    .map((cp, i) => ({ cp, i }))
    .filter(({ cp }) => typeof cp.est_value_usd_per_kw_year === 'number' && cp.est_value_usd_per_kw_year > 0 && chargeAppliesToSite(cp, site))
    .map(({ cp, i }) => {
      const hours = cp.dispatch_hours || a.cp_dispatch_hours;
      const kw = deliverableKw(config, site, a, hours, { capAtLoad: true }) * a.cp_hit_rate;
      const pass = tagPassThrough(cp, site);
      const optional = !!cp.optional_election;
      return {
        key: `cp:${i}`,
        category: 'coincident_peak',
        label: `Peak-tag reduction — ${cpLabel(cp.type)}`,
        annual_usd: kw * cp.est_value_usd_per_kw_year,
        upfront_usd: 0,
        scenario: pass.base && !optional ? 'base' : 'upside',
        cp_type: cp.type,
        confidence: cp.overridden ? 'user' : cp.confidence || tariff.confidence || 'medium',
        kw_used: kw,
        rate: cp.est_value_usd_per_kw_year,
        unit: '$/kW-yr',
        basis_text: `${fmt(kw)} kW (sustained ${hours} h × ${a.cp_hit_rate} hit rate) × $${cp.est_value_usd_per_kw_year}/kW-yr`,
        source_id: tariff.id,
        notes: [optional ? 'Optional rate election — counted in upside only.' : '', cp.how_set, cp.passthrough_notes].filter(Boolean).join(' '),
        flags: [pass.flag || '', optional ? 'optional_election' : ''].filter(Boolean),
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

/**
 * TOU energy arbitrage: discharge in the peak window, recharge off-peak (losses priced at off-peak).
 * Energy already spent shaving demand outside the window is unavailable, and recharging must fit under
 * the demand caps the shave set (charging must not create a new billed peak).
 */
export function arbitrageStreams(site, config, tariff, a, profile, monthOpt = {}) {
  const seasons = tariff?.arbitrage || [];
  const P = profile.kw;
  const dt = profile.dtHours;
  return seasons
    .filter((s) => typeof s.peak_price === 'number' && typeof s.offpeak_price === 'number')
    .filter((s) => !s.requires_supply || s.requires_supply === site.supply_contract)
    .map((s, i) => {
      const win = s.peak_window || { start: 16, end: 21 };
      const mask = windowMask(P.length, dt, win);
      const winHours = mask.filter(Boolean).length * dt;
      let windowLoadKwh = 0;
      P.forEach((kw, idx) => {
        if (mask[idx]) windowLoadKwh += kw * dt;
      });
      const months = s.months?.length ? s.months : ALL_MONTHS;
      const opt = monthOpt[months[0]];
      let outside = 0;
      let room = 0;
      for (let k = 0; k < P.length; k++) {
        if (mask[k]) continue;
        const d = opt ? opt.discharge[k] : 0;
        outside += d * dt;
        if (d > 0) continue;
        const cap = opt ? opt.caps[k] : Infinity;
        room += Math.min(config.kw, cap === Infinity ? config.kw : Math.max(0, cap - P[k])) * dt;
      }
      const eDis = Math.max(0, Math.min(usableKwh(config, a) - outside, config.kw * winHours, site.export_allowed ? Infinity : windowLoadKwh, room * a.rte_ac - outside));
      const perDay = Math.max(0, eDis * s.peak_price - (eDis / a.rte_ac) * s.offpeak_price);
      const dayFrac = s.days === 'all' ? 1 : 5 / 7;
      const days = months.reduce((n, m) => n + DAYS_IN_MONTH[m - 1] * dayFrac, 0);
      return {
        key: `arb:${i}`,
        category: 'energy_arbitrage',
        label: `TOU energy shifting — ${s.label || 'season ' + (i + 1)}`,
        annual_usd: perDay * days * a.arbitrage_capture,
        upfront_usd: 0,
        scenario: 'base',
        confidence: s.confidence || tariff.confidence || 'medium',
        kw_used: winHours ? eDis / winHours : 0,
        rate: s.peak_price - s.offpeak_price,
        unit: '$/kWh spread',
        basis_text: `${fmt(eDis)} kWh/day × ($${s.peak_price} peak − $${s.offpeak_price}/${a.rte_ac} RTE off-peak) × ${Math.round(days)} days × ${a.arbitrage_capture} capture${outside > 0.5 ? ` (after ${fmt(outside)} kWh/day used for demand shaving outside the window)` : ''}`,
        source_id: tariff.id,
        notes: s.notes || '',
        flags: [],
      };
    })
    .filter((s) => s.annual_usd > 0);
}

/**
 * Program eligibility for a site/config. `creditedKw` (deliverable kW for the event duration) is compared
 * with kW minimums for dispatch programs; nameplate otherwise. Returns {eligible, reason, viaAggregator}.
 */
export function programEligibility(program, site, config, creditedKw) {
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
  const kwForMin = creditedKw ?? config.kw;
  if (typeof e.min_kw === 'number' && kwForMin < e.min_kw) {
    const what = creditedKw != null && creditedKw < config.kw ? `${fmt(kwForMin)} kW deliverable for the event duration is below` : 'Below';
    if (e.requires_aggregator_or_csp || e.aggregation_allowed) {
      return { eligible: true, viaAggregator: true, reason: `${what} the ${e.min_kw} kW minimum on its own — eligible only inside an aggregation` };
    }
    return { eligible: false, reason: `${what} the program minimum of ${e.min_kw} kW` };
  }
  return { eligible: true, viaAggregator: !!e.requires_aggregator_or_csp };
}

/** Value of one program for a config. Returns a stream or null. */
export function programStream(program, site, config, a, ctx = {}) {
  const v = program.valuation || {};
  if (typeof v.rate !== 'number' || v.method === 'text_only') return null;
  const e = program.eligibility || {};
  const isDispatch = DISPATCH_CATEGORIES.has(program.category) && !v.method?.startsWith('upfront') && v.method !== 'pct_of_cost';
  const assumedHours = isDispatch && !v.duration_basis_hr && !program.dispatch?.event_duration_hr;
  const hours = v.duration_basis_hr || program.dispatch?.event_duration_hr || (assumedHours ? a.default_dr_event_hours || 0 : 0);
  const dk = deliverableKw(config, site, a, hours, { capAtLoad: !e.requires_export });
  const elig = programEligibility(program, site, config, isDispatch ? dk : undefined);
  if (!elig.eligible) return null;
  const tier = (v.rate_by_site_peak_kw || []).find((t) => t.max_peak_kw == null || site.peak_kw <= t.max_peak_kw);
  let rate = site.program_rate_overrides?.[program.id] ?? tier?.rate ?? v.rate;
  const flags = [];
  const notes = [elig.reason, tier?.label ? `Rate tier: ${tier.label}` : ''];
  // Net value factors for wholesale/aggregator programs.
  const perf = isDispatch ? a.dr_performance : 1;
  const accreditation = typeof v.accreditation_factor === 'number' ? v.accreditation_factor : 1;
  const share = elig.viaAggregator || e.requires_aggregator_or_csp ? a.aggregator_customer_share ?? 1 : 1;
  const net = accreditation * share;
  const netText = `${accreditation !== 1 ? ` × ${accreditation} accreditation` : ''}${share !== 1 ? ` × ${share} customer share after aggregator` : ''}`;
  let annual = 0;
  let upfront = 0;
  let basis = '';
  const kwhBasis = typeof v.max_kwh_incentivized === 'number' ? Math.min(config.kwh, v.max_kwh_incentivized) : config.kwh;
  const kwBasis = typeof v.max_kw_incentivized === 'number' ? Math.min(config.kw, v.max_kw_incentivized) : config.kw;
  let schedule = v.schedule || null;
  switch (v.method) {
    case 'per_kw_season': {
      const seasons = v.seasons_per_year || 1;
      annual = rate * dk * perf * seasons * net;
      basis = `${fmt(dk)} kW deliverable over ${hours || '—'} h × ${perf} performance${netText} × $${rate}/kW-season${seasons > 1 ? ` × ${seasons} seasons` : ''}`;
      break;
    }
    case 'per_kw_month': {
      const months = v.months_per_year || 12;
      annual = rate * dk * perf * months * net;
      basis = `${fmt(dk)} kW over ${hours || '—'} h × ${perf} perf${netText} × $${rate}/kW-mo × ${months} months`;
      break;
    }
    case 'per_kw_year':
      annual = rate * dk * perf * net;
      basis = `${fmt(dk)} kW over ${hours || '—'} h × ${perf} perf${netText} × $${rate}/kW-yr`;
      break;
    case 'per_kwh_event': {
      const evh = v.expected_event_hours_per_year || 0;
      annual = rate * dk * perf * evh * net;
      basis = `${fmt(dk)} kW × ${perf} perf${netText} × ${evh} event-h/yr × $${rate}/kWh`;
      break;
    }
    case 'per_mwh': {
      const evh = v.expected_event_hours_per_year || 0;
      annual = (rate / 1000) * dk * perf * evh * net;
      basis = `${fmt(dk)} kW × ${evh} h/yr${netText} × $${rate}/MWh`;
      break;
    }
    case 'upfront_per_kwh':
      upfront = rate * kwhBasis;
      basis = `${fmt(kwhBasis)} kWh × $${rate}/kWh`;
      break;
    case 'upfront_per_kw':
      upfront = rate * kwBasis;
      basis = `${fmt(kwBasis)} kW × $${rate}/kW`;
      break;
    case 'pct_of_cost': {
      if (config.installedCostUsd == null) return null;
      // Federal ITC: projects ≥ 1 MW AC need prevailing wage & apprenticeship for the full rate.
      if (typeof v.pwa_threshold_kw === 'number' && config.kw >= v.pwa_threshold_kw && !a.itc_pwa_confirmed && typeof v.rate_without_pwa === 'number' && site.program_rate_overrides?.[program.id] == null) {
        rate = v.rate_without_pwa;
        flags.push('pwa_unconfirmed');
        notes.push(`≥ ${v.pwa_threshold_kw} kW AC: base rate without prevailing wage & apprenticeship.`);
      }
      const basisCost = Math.max(0, config.installedCostUsd - (a.incentives_reduce_itc_basis ? ctx.otherUpfront || 0 : 0));
      upfront = rate * basisCost;
      basis = `${(rate * 100).toFixed(0)}% × $${fmt(basisCost)} eligible cost`;
      break;
    }
    default:
      return null;
  }
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
  // Benefits paid out over several years (e.g. NYC property-tax abatement over 4 years).
  if (upfront > 0 && typeof v.spread_years === 'number' && v.spread_years > 1) {
    annual = upfront / v.spread_years;
    upfront = 0;
    schedule = [{ start_year: 1, end_year: v.spread_years, factor: 1 }];
    basis += ` paid over ${v.spread_years} years`;
  }

  // Base vs upside.
  let scenario = BASE_STATUSES.has(program.status) ? 'base' : 'upside';
  if (program.requires_confirmation && !site.confirmed_programs?.[program.id]) {
    scenario = 'upside';
    flags.push('eligibility_unconfirmed');
    notes.push(program.requires_confirmation);
  }
  if (e.requires_property_owner && site.property_owner !== true) {
    scenario = 'upside';
    flags.push('property_owner_only');
    notes.push('Only a building owner with property-tax liability captures this.');
  }
  if (program.feoc_applies && !a.itc_feoc_confirmed) {
    scenario = 'upside';
    flags.push('feoc_unconfirmed');
    notes.push('Counted in upside until the products are confirmed compliant with the foreign-entity (FEOC/MACR) rules (Settings).');
  }
  if (elig.viaAggregator) flags.push('aggregator_required');
  if (hours && config.durationHr < hours) flags.push('duration_short');
  if (assumedHours && hours) flags.push('duration_assumed');
  const d = program.dispatch || {};
  const event = isDispatch && d.event_block && d.event_months?.length ? { program_id: program.id, months: d.event_months, block: d.event_block, kw: dk } : null;
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
    schedule,
    no_degradation: !!v.spread_years,
    notes: notes.filter(Boolean).join(' '),
    flags,
    event,
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
export function cyclingLossStream(site, config, a, cyclingKwhPerYear, hasArbitrage) {
  if (hasArbitrage || !(cyclingKwhPerYear > 0) || !(site.energy_price > 0)) return null;
  const loss = cyclingKwhPerYear * (1 / a.rte_ac - 1) * site.energy_price;
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
    basis_text: `${fmt(cyclingKwhPerYear)} kWh/yr discharged for demand management × (1/${a.rte_ac} − 1) × $${site.energy_price}/kWh`,
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

  // Programs first: their event days constrain demand shaving, and rebates net out of the ITC basis.
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
  const events = kept.filter((s) => s.event && s.scenario === 'base').map((s) => s.event);

  const { streams: demand, cyclingKwhPerYear, monthOpt } = demandChargeStreams(site, config, tariff, a, profile, events);
  const cp = coincidentStreams(site, config, tariff, a);
  const arb = arbitrageStreams(site, config, tariff, a, profile, monthOpt);
  const otherUpfront = kept.filter((s) => s.scenario === 'base').reduce((n, s) => n + s.upfront_usd, 0);
  const tax = taxPrograms.map((p) => programStream(p, site, config, a, { ...ctx, otherUpfront })).filter(Boolean);
  const loss = cyclingLossStream(site, config, a, cyclingKwhPerYear, arb.length > 0);

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
