// Site-limitation engine: what physically, electrically, or by code/rule caps battery size at a site.
// Each check returns a severity: info | caution | critical. "critical" means the configuration is not
// feasible as specified without a mitigation (new switchgear, outdoor siting, etc.).

import { kvaFromAmps, nec120PercentLimit, chargingHeadroomKw, ampsFromKw } from './electrical.js';

export const SEVERITY_ORDER = { ok: 0, info: 1, caution: 2, critical: 3 };

const worst = (a, b) => (SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b);

/** Find a code rule by type: jurisdiction-specific first, then the global (model code) default. */
export function findRule(ctx, ruleType) {
  const j = (ctx.jurisdiction?.site_constraints || []).find((c) => c.rule_type === ruleType && appliesToSite(c, ctx.site));
  if (j) return j;
  return (ctx.global?.site_constraints || []).find((c) => c.rule_type === ruleType) || null;
}

/** All matching rules: jurisdiction-specific ones if any exist for this type, else the global ones. */
export function findRules(ctx, ruleType) {
  const j = (ctx.jurisdiction?.site_constraints || []).filter((c) => c.rule_type === ruleType && appliesToSite(c, ctx.site));
  if (j.length) return j;
  return (ctx.global?.site_constraints || []).filter((c) => c.rule_type === ruleType);
}

function appliesToSite(rule, site) {
  if (!rule.utility_ids?.length) return true;
  return site && rule.utility_ids.includes(site.utility_id);
}

/** Site-level limits independent of a specific configuration. */
export function siteLimits(site, ctx, profile) {
  const phases = site.phases || 3;
  const serviceKva = kvaFromAmps(site.service_voltage, site.service_amps, phases);
  const nec = nec120PercentLimit({
    busbarAmps: site.busbar_amps || site.service_amps,
    mainBreakerAmps: site.main_breaker_amps || site.service_amps,
    volts: site.service_voltage,
    phases,
  });
  const minLoad = site.min_load_kw ?? (profile ? Math.min(...profile.kw) : null);
  const overnightLoad = minLoad ?? site.peak_kw * 0.4;
  const chargeHeadroom = serviceKva ? chargingHeadroomKw({ serviceKva, loadAtChargeKw: overnightLoad }) : null;
  const peakHeadroom = serviceKva ? chargingHeadroomKw({ serviceKva, loadAtChargeKw: site.peak_kw }) : null;
  const usefulKwCeiling = site.export_allowed ? null : Math.max(0, site.peak_kw * (ctx.assumptions?.event_load_fraction ?? 0.85));
  const indoorRule = findRule(ctx, 'indoor_max_kwh');
  const unitRule = findRule(ctx, 'unit_max_kwh');
  const products = ctx.products || [];
  const maxUnitsBySpace = {};
  for (const p of products) {
    if (site.available_area_sqft > 0 && p.footprint_sqft > 0) {
      maxUnitsBySpace[p.id] = Math.floor(site.available_area_sqft / p.footprint_sqft);
    }
  }
  const util = (ctx.jurisdiction?.utilities || []).find((u) => u.id === site.utility_id);
  return {
    serviceKva,
    nec120: nec,
    chargeHeadroomKw: chargeHeadroom,
    peakChargeHeadroomKw: peakHeadroom,
    minLoadKw: minLoad,
    usefulKwCeiling,
    indoorMaxKwh: indoorRule?.threshold?.value ?? null,
    unitMaxKwh: unitRule?.threshold?.value ?? null,
    maxUnitsBySpace,
    interconnectionTracks: util?.interconnection?.tracks || [],
  };
}

/** All checks for one configuration at one site. */
export function checkConfig(site, config, ctx, limits) {
  const checks = [];
  const add = (c) => checks.push({ persona: 'bess-ix', ...c });
  const phases = site.phases || 3;

  // 1. NEC 705.12 load-side connection.
  if (limits.nec120) {
    const invAmps = ampsFromKw(config.kw, site.service_voltage, phases);
    if (config.kw > limits.nec120.maxInverterKw + 0.01) {
      add({
        id: 'nec-120',
        severity: 'caution',
        title: 'Exceeds NEC 120% rule for a backfed-breaker connection',
        detail: `${config.kw} kW draws ≈${Math.round(invAmps)} A at ${site.service_voltage} V; the ${site.busbar_amps || site.service_amps} A busbar with a ${site.main_breaker_amps || site.service_amps} A main allows ≈${Math.round(limits.nec120.maxInverterAmps)} A (${limits.nec120.maxInverterKw.toFixed(0)} kW) on a load-side breaker.`,
        mitigation: 'Supply-side (line-side) tap per NEC 705.11, main breaker derate, a UL 1741 CRD Power Control System per 705.13, or new switchgear. Budget engineering + utility coordination.',
        limit: { kw: limits.nec120.maxInverterKw },
      });
    } else {
      add({
        id: 'nec-120',
        severity: 'ok',
        title: 'Fits a load-side breaker under the NEC 120% rule',
        detail: `≈${Math.round(invAmps)} A inverter current vs ≈${Math.round(limits.nec120.maxInverterAmps)} A allowed.`,
      });
    }
  } else {
    add({ id: 'nec-120', severity: 'info', title: 'Electrical service data missing', detail: 'Enter service voltage, amps, busbar and main breaker ratings to check the NEC 705.12 interconnection limit and charging headroom.' });
  }

  // 2. Charging headroom on the service.
  if (limits.chargeHeadroomKw != null) {
    if (config.kw > limits.chargeHeadroomKw) {
      add({
        id: 'charge-headroom',
        severity: limits.chargeHeadroomKw <= 0 ? 'critical' : 'caution',
        title: 'Charging could overload the existing service',
        detail: `Service ≈${limits.serviceKva.toFixed(0)} kVA; continuous capacity left at overnight load ≈${Math.max(0, limits.chargeHeadroomKw).toFixed(0)} kW vs ${config.kw} kW charge rate.`,
        mitigation: 'Cap charge rate with the site controller/PCS (charge slower over more hours) or upgrade the service. Utility may require a load letter for added charging load.',
        limit: { kw: Math.max(0, limits.chargeHeadroomKw) },
      });
    } else if (limits.peakChargeHeadroomKw != null && config.kw > limits.peakChargeHeadroomKw) {
      add({
        id: 'charge-headroom',
        severity: 'info',
        title: 'Charging must be scheduled off-peak',
        detail: `Charging at full ${config.kw} kW during the site peak would exceed service capacity (≈${Math.max(0, limits.peakChargeHeadroomKw).toFixed(0)} kW headroom at peak). Fine if the controller only charges overnight.`,
      });
    }
  }

  // 3. Useful discharge ceiling (non-export).
  if (limits.usefulKwCeiling != null && config.kw > limits.usefulKwCeiling) {
    add({
      id: 'oversized-kw',
      severity: 'caution',
      title: 'Battery kW exceeds what the site can absorb without exporting',
      detail: `Non-export: discharge is capped near site load (≈${limits.usefulKwCeiling.toFixed(0)} kW during peak events, ≈${limits.minLoadKw != null ? limits.minLoadKw.toFixed(0) : '?'} kW at minimum load). Extra kW is stranded.`,
      mitigation: 'Choose fewer/smaller units, or pursue an export-capable interconnection (longer study, VDER/wholesale paths).',
      limit: { kw: limits.usefulKwCeiling },
    });
  }

  // 4. Interconnection track.
  // Tracks are listed smallest → largest; a null max_kw means no stated upper bound.
  const tracks = limits.interconnectionTracks || [];
  if (tracks.length) {
    const t = tracks.find((tr) => tr.max_kw == null || config.kw <= tr.max_kw);
    add({
      id: 'ix-track',
      severity: t && t === tracks[0] ? 'ok' : 'info',
      title: t ? `Interconnection: likely "${t.name}" track${t.max_kw != null ? ` (≤ ${t.max_kw} kW)` : ''}` : `Interconnection: above ${tracks[tracks.length - 1].max_kw} kW — full study track`,
      detail: [t?.conditions, t?.typical_timeline ? `Timeline: ${t.typical_timeline}` : '', t?.application_fee ? `Fee: ${t.application_fee}` : ''].filter(Boolean).join(' '),
    });
  }

  // 5. Secondary network.
  if (site.network_secondary === 'yes') {
    add({
      id: 'network',
      severity: site.export_allowed ? 'critical' : 'caution',
      title: 'Site is on a secondary network grid',
      detail: site.export_allowed
        ? 'Export on spot/area networks can trip network protectors; utilities generally prohibit or severely limit it.'
        : 'Non-export is required and typically needs reverse-power / minimum-import protection and a network review. Expect longer review and possible inverter-size limits relative to minimum load.',
      mitigation: 'Design as non-export with redundant reverse-power protection; get the utility network review started early.',
    });
  } else if (site.network_secondary === 'unknown') {
    add({ id: 'network', severity: 'info', title: 'Confirm whether the site is on a secondary network', detail: 'Dense downtown areas (Manhattan, Boston, Chicago Loop, downtown SF) are often networked, which restricts export and adds review.' });
  }

  // 6. Fire code: per-unit size and indoor aggregate.
  const unitRule = findRule(ctx, 'unit_max_kwh');
  const products = ctx.products || [];
  const largestUnit = Math.max(0, ...config.items.map((it) => products.find((p) => p.id === it.productId)?.kwh || 0));
  if (unitRule?.threshold?.value && largestUnit > unitRule.threshold.value) {
    add({
      id: 'fire-unit-size',
      persona: 'permitting',
      severity: 'info',
      title: `Units exceed ${unitRule.threshold.value} kWh — large-scale fire test data required`,
      detail: `${unitRule.rule} Each ${largestUnit} kWh unit needs UL 9540 listing plus UL 9540A large-scale test results accepted by the fire official to justify unit size and spacing.`,
      sources: unitRule.sources,
    });
  }
  const indoorRule = findRule(ctx, 'indoor_max_kwh');
  if (site.install_location === 'indoor' && indoorRule?.threshold?.value) {
    const cap = indoorRule.threshold.value;
    add({
      id: 'fire-indoor',
      persona: 'permitting',
      severity: config.kwh > cap ? 'critical' : 'caution',
      title: config.kwh > cap ? `Indoor aggregate ${config.kwh} kWh exceeds ${cap} kWh limit` : `Indoor installation: ${config.kwh} kWh within ${cap} kWh aggregate`,
      detail: `${indoorRule.rule}`,
      mitigation: config.kwh > cap ? 'Move outdoors, split into separate fire areas (rated separation), or obtain AHJ approval based on large-scale fire testing.' : 'Indoor Li-ion ESS still needs dedicated room, detection, ventilation/explosion control and AHJ approval.',
      limit: { kwh: cap },
      sources: indoorRule.sources,
    });
  }
  for (const [loc, type] of [
    ['rooftop', 'rooftop_rule'],
    ['parking_garage', 'garage_rule'],
  ]) {
    if (site.install_location !== loc) continue;
    const r = findRule(ctx, type);
    add({
      id: `fire-${loc}`,
      persona: 'permitting',
      severity: r?.severity || 'caution',
      title: r?.title || `${loc === 'rooftop' ? 'Rooftop' : 'Parking garage'} installation has added restrictions`,
      detail: r?.rule || 'Check local fire code; additional fire separation, access, and structural review apply.',
      limit: r?.threshold?.metric === 'kWh' ? { kwh: r.threshold.value } : undefined,
      sources: r?.sources,
    });
    if (r?.threshold?.metric === 'kWh' && config.kwh > r.threshold.value) {
      add({
        id: `fire-${loc}-cap`,
        persona: 'permitting',
        severity: 'critical',
        title: `${config.kwh} kWh exceeds the ${r.threshold.value} kWh ${loc.replace('_', ' ')} limit`,
        detail: r.rule,
        limit: { kwh: r.threshold.value },
      });
    }
  }
  const setbackRule = findRule(ctx, 'outdoor_setback_ft');
  if ((site.install_location || 'outdoor_ground') === 'outdoor_ground' && site.setback_ok === 'no') {
    add({
      id: 'fire-setback',
      persona: 'permitting',
      severity: 'caution',
      title: `Outdoor setback (${setbackRule?.threshold?.value ?? 10} ft) not available`,
      detail: setbackRule?.rule || 'Outdoor ESS generally needs ~10 ft from buildings, lot lines, public ways and egress unless reduced by fire barriers or large-scale fire test data.',
      mitigation: 'Use units with UL 9540A data supporting reduced separation, add a rated fire barrier, or relocate.',
    });
  }
  for (const permitRule of findRules(ctx, 'permit_threshold_kwh')) {
    if (permitRule?.threshold?.value && config.kwh > permitRule.threshold.value) {
      add({ id: `permit-${permitRule.id}`, persona: 'permitting', severity: permitRule.severity || 'info', title: permitRule.title || 'Permit required', detail: permitRule.rule, sources: permitRule.sources });
    }
  }
  // Outdoor groups above the indoor-style 600 kWh limit (some readings of IFC Table 1207.8 / AHJs apply it outdoors).
  const groupRule = findRule(ctx, 'outdoor_group_max_kwh');
  const loc = site.install_location || 'outdoor_ground';
  if (groupRule?.threshold?.value && (loc === 'outdoor_ground' || loc === 'rooftop') && config.kwh > groupRule.threshold.value) {
    add({
      id: 'fire-outdoor-group',
      persona: 'permitting',
      severity: 'caution',
      title: `${config.kwh} kWh outdoors exceeds a ${groupRule.threshold.value} kWh group`,
      detail: groupRule.rule,
      mitigation: 'Split into separated groups as the AHJ requires, site it as a remote outdoor installation (>100 ft from exposures), or provide a Hazard Mitigation Analysis plus large-scale fire test data.',
      sources: groupRule.sources,
    });
  }

  // 7. Space.
  for (const it of config.items) {
    const maxU = limits.maxUnitsBySpace?.[it.productId];
    if (maxU != null && it.count > maxU) {
      add({
        id: `space-${it.productId}`,
        severity: 'critical',
        title: 'Not enough pad area',
        detail: `${it.count} units need more than the ${site.available_area_sqft} sq ft available (fits ${maxU} incl. clearances).`,
        limit: { units: maxU },
      });
    }
  }

  // 8. Flood.
  if (site.flood_zone === 'yes') {
    add({ id: 'flood', severity: 'caution', title: 'Flood zone', detail: 'Elevate equipment above design flood elevation (+ freeboard per local code); check insurer requirements.' });
  }

  // 9. Jurisdiction rules flagged as size-limiting text (informational).
  for (const c of ctx.jurisdiction?.site_constraints || []) {
    if (!c.rule_type || !c.threshold?.value) continue;
    if (c.rule_type === 'site_max_kwh' && config.kwh > c.threshold.value && appliesToSite(c, site)) {
      add({ id: c.id, persona: c.persona || 'permitting', severity: c.severity || 'caution', title: c.title, detail: c.rule, limit: { kwh: c.threshold.value }, sources: c.sources });
    }
    if (c.rule_type === 'site_max_kw' && config.kw > c.threshold.value && appliesToSite(c, site)) {
      add({ id: c.id, persona: c.persona || 'bess-ix', severity: c.severity || 'caution', title: c.title, detail: c.rule, limit: { kw: c.threshold.value }, sources: c.sources });
    }
  }

  const status = checks.reduce((s, c) => worst(s, c.severity), 'ok');
  return { status, checks };
}
