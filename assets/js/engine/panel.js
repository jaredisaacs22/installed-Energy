// Rule-based expert panel. Each persona is a simulated advisory perspective (not affiliated with or
// endorsed by any company). Notes come from two places:
//   1. Static market briefings researched per jurisdiction (data/jurisdictions/*.json → panel_notes)
//   2. Dynamic rules evaluated against this site's inputs and results (below)

import { fmt } from './value.js';

/** Persona id that speaks for a site's utility. */
export function utilityPersonaFor(site, panel) {
  const p = (panel?.personas || []).find((x) => (x.utility_ids || []).includes(site.utility_id));
  if (p) return p.id;
  const j = (panel?.personas || []).find((x) => x.kind === 'utility' && (x.jurisdictions || []).includes(site.jurisdiction));
  return j ? j.id : 'bess-ix';
}

/** Static notes relevant to this site: persona matches site's utility persona or a cross-cutting persona. */
export function briefingNotes(site, jurisdiction, panel) {
  const util = utilityPersonaFor(site, panel);
  const cross = new Set((panel?.personas || []).filter((p) => p.kind !== 'utility').map((p) => p.id));
  return (jurisdiction?.panel_notes || []).filter((n) => n.persona_id === util || cross.has(n.persona_id) || !n.persona_id);
}

/**
 * Dynamic review of the recommended configuration (and site-level issues).
 * @returns Array<{persona, severity, title, text}>
 */
export function panelReview(site, analysis, ctx) {
  const notes = [];
  const add = (persona, severity, title, text) => notes.push({ persona, severity, title, text });
  const util = utilityPersonaFor(site, ctx.panel);
  const rec = analysis.recommended;
  const tariff = analysis.tariff;

  // Constraint checks of the recommended config become BESS-IX / permitting notes.
  if (rec) {
    for (const c of rec.constraints.checks) {
      if (c.severity === 'ok') continue;
      add(c.persona || 'bess-ix', c.severity, c.title, [c.detail, c.mitigation ? `Mitigation: ${c.mitigation}` : ''].filter(Boolean).join(' '));
    }
  }

  // Duration shortfall vs program event length.
  if (rec) {
    for (const s of rec.streams) {
      if (!s.flags?.includes('duration_short')) continue;
      add(
        'bess-ix',
        'caution',
        `${rec.config.durationHr.toFixed(1)} h battery is energy-limited for "${s.label}"`,
        `Only ${fmt(s.kw_used)} kW of the ${rec.config.kw} kW nameplate can be held for the full event, so payments are based on ${fmt(s.kw_used)} kW. A longer-duration unit (e.g. the 5 h or 3 h products) earns more per kW in this program.`,
      );
    }
  }

  // Supply contract / tag pass-through.
  const cpStreams = rec ? rec.streams.filter((s) => s.category === 'coincident_peak') : [];
  if (cpStreams.length) {
    const cpUsd = cpStreams.reduce((n, s) => n + s.annual_usd, 0);
    if (site.supply_contract === 'default_service' && cpStreams.some((s) => s.flags?.includes('default_service_no_tags'))) {
      add('constellation', 'info', 'Default utility supply does not pass peak tags through', `About $${fmt(cpUsd)}/yr of tag reduction is counted only in upside. On fixed-price default/basic service the customer pays an averaged capacity cost, so cutting their own tag doesn't lower the bill. A competitive pass-through contract would capture it.`);
    } else if (site.supply_contract === 'fixed_all_in') {
      add('constellation', 'caution', 'Fixed all-in supply contract hides tag savings', `About $${fmt(cpUsd)}/yr of capacity/transmission tag reduction is counted only in the upside case. A fixed all-in contract won't pass it through until renewal. Re-price at renewal with tags passed through, or move to an index/pass-through product.`);
    } else if (!site.supply_contract || site.supply_contract === 'unknown') {
      add('constellation', 'caution', 'Supply contract unknown: tag savings held in upside', `$${fmt(cpUsd)}/yr of capacity/transmission tag reduction counts only once the supply contract is confirmed to pass tags through (index or pass-through). Set the supply contract in step 5.`);
    }
    add('bess-ix', 'info', 'Peak-tag capture needs forecasting and reserved energy', `Tag values assume ${Math.round((ctx.assumptions.cp_hit_rate || 0) * 100)}% of system peak hours are caught. The battery must hold charge on likely peak days, which can conflict with daily demand shaving on the same afternoons.`);
  }

  // Aggregator-dependent revenue.
  if (rec) {
    const agg = rec.streams.filter((s) => s.flags?.includes('aggregator_required'));
    if (agg.length) {
      add('constellation', 'info', 'Revenue that depends on an aggregator / CSP', `${agg.map((s) => s.label).join('; ')} pay through a curtailment service provider or aggregator. They keep a share and set performance terms. This is the natural first step toward your own VPP.`);
    }
  }

  // Ratchets.
  if (tariff?.ratchet) {
    add(util, 'caution', 'Demand ratchet on this rate', `${tariff.ratchet.pct ? Math.round(tariff.ratchet.pct * 100) + '% ' : ''}ratchet${tariff.ratchet.lookback_months ? ` over ${tariff.ratchet.lookback_months} months` : ''} (${tariff.ratchet.applies_to || 'billing demand'}). One missed peak (battery empty, offline or derated) can set billing demand for many months. Size with a reserve and keep high availability.`);
  }

  // Tariff applicability.
  const ap = tariff?.applicability;
  if (ap && ((typeof ap.min_kw === 'number' && site.peak_kw < ap.min_kw) || (typeof ap.max_kw === 'number' && site.peak_kw > ap.max_kw))) {
    add(util, 'caution', 'Site demand is outside this rate\'s applicability', `${tariff.name} applies to ${ap.min_kw ?? 0}–${ap.max_kw ?? '∞'} kW; the site peaks at ${site.peak_kw} kW. Check the customer's actual rate on a bill. Lowering the peak with storage can also move the account to another rate class.`);
  }

  // Program status.
  for (const p of ctx.programs || []) {
    if (p.utility_ids?.length && !p.utility_ids.includes(site.utility_id)) continue;
    if (p.status === 'waitlist' || p.status === 'pending_launch') {
      add(util, 'info', `${p.name}: ${p.status.replace('_', ' ')}`, `${p.status_notes || 'Funding/enrollment not currently open.'} Counted in the upside case only.`);
    }
    if (p.status === 'closed' || p.status === 'paused') {
      if (p.category === 'upfront_incentive') add(util, 'info', `${p.name}: ${p.status}`, p.status_notes || 'Not counted in the value stack.');
    }
  }

  // Tax credit gating.
  if (rec?.streams.some((s) => s.flags?.includes('feoc_unconfirmed'))) {
    add('bess-ix', 'caution', 'ITC depends on supply-chain (FEOC/MACR) compliance', 'For storage starting construction after 2025, the §48E credit requires the battery’s material-assistance cost ratio from non-prohibited foreign entities to meet the annual threshold (55% in 2026, rising after). Many LFP cabinets with Chinese cells fail it. Get the supplier’s MACR certification, then confirm in Settings to count the ITC in the base case.');
  }
  if (rec?.streams.some((s) => s.flags?.includes('pwa_unconfirmed'))) {
    add('bess-ix', 'info', 'At ≥ 1 MW AC the ITC needs prevailing wage & apprenticeship', 'Without PWA the credit drops from 30% to 6%. Keep site AC capacity under 1 MW, or plan for PWA compliance.');
  }
  if (rec?.streams.some((s) => s.flags?.includes('event_days_limit_shave'))) {
    add('bess-ix', 'caution', 'DR event days limit demand-charge savings', 'In months with frequent dispatch events the battery spends its energy on the event block, so it only shaves the site’s peak if that peak falls inside the event hours. The monthly demand saving here uses the lesser of a normal day and an event day. Check event windows against the site’s interval data.');
  }
  for (const s of rec?.streams || []) {
    if (!s.flags?.includes('eligibility_unconfirmed')) continue;
    const p = (ctx.programs || []).find((x) => x.id === s.program_id);
    if (p && !p.panel_caution) add(util, 'caution', `${p.name}: eligibility unconfirmed (upside only)`, `${p.requires_confirmation} Tick “Confirmed eligible” in the programs list once confirmed to count it in the base case.`);
  }

  // Programs the recommended stack depends on that carry an explicit research caution.
  if (rec) {
    for (const s of rec.streams) {
      const p = (ctx.programs || []).find((x) => x.id === s.program_id);
      if (p?.panel_caution) add(util, 'caution', `Verify before counting on ${p.name}`, p.panel_caution);
    }
  }

  // Programs that only an export-capable interconnection would unlock.
  if (!site.export_allowed) {
    const unlock = (ctx.programs || []).filter((p) => p.eligibility?.requires_export && !['closed', 'paused'].includes(p.status) && p.valuation?.rate != null);
    if (unlock.length) {
      add(util, 'info', 'Export-capable interconnection would unlock more programs', `${unlock.map((p) => `${p.name} (${p.valuation.rate} ${p.valuation.unit || ''})`).join('; ')}. They require exporting to the grid, so they are excluded for a non-export design. Weigh them against the longer interconnection study and the network/protection limits.`);
    }
  }

  // Confidence of the value stack.
  if (rec) {
    const total = rec.streams.reduce((n, s) => n + Math.max(0, s.annual_usd) + Math.max(0, s.upfront_usd) / 5, 0);
    const low = rec.streams.filter((s) => s.confidence === 'low').reduce((n, s) => n + Math.max(0, s.annual_usd) + Math.max(0, s.upfront_usd) / 5, 0);
    if (total > 0 && low / total > 0.3) {
      add('bess-ix', 'caution', 'A large share of value rests on low-confidence data', `${Math.round((100 * low) / total)}% of the stack comes from inputs marked low confidence. Check them against the current tariff sheet or program manual before using this site in an investment decision.`);
    }
  }

  // Small sites & wholesale minimums.
  if (site.peak_kw < 100) {
    add('constellation', 'info', 'Small site: wholesale programs require aggregation', 'Most ISO demand-response and ancillary products have a 100 kW minimum. This site only reaches them as part of a multi-site portfolio, which is the VPP play.');
  }

  // Load-shape provenance.
  if (analysis.profile?.source !== 'custom' && !Object.keys(site.shave_kw_override || {}).length) {
    add('bess-ix', 'info', 'Demand savings use a generic design-day shape', `Peak-shave kW comes from a ${site.building_type || 'office'} profile adjusted to the site's load factor. Paste a peak-day profile or enter shave kW from your interval model to replace it. Needle peaks (short spikes) are usually cheaper to shave than this suggests; broad plateaus are harder.`);
  }

  // Same battery-hours sold twice?
  if (rec) {
    const hasDemand = rec.streams.some((s) => s.category === 'demand_charge' && s.annual_usd > 0);
    const dr = rec.streams.filter((s) => s.category === 'demand_response' && s.annual_usd > 0);
    if (hasDemand && dr.length) {
      add('bess-ix', 'info', 'Stacking assumes DR events line up with the site peak', `Demand-charge savings and ${dr.map((s) => s.label).join(', ')} both assume the battery discharges on the same hot afternoons. If an event window misses the site's own peak hour, the battery can't fully do both that day. Check event windows against the site's interval data.`);
    }
  }

  // Metering & telemetry for DR/VPP.
  if (rec?.streams.some((s) => s.category === 'demand_response')) {
    add('bess-ix', 'info', 'Metering & telemetry for DR settlement', 'DR and VPP programs settle on revenue-grade interval data. Confirm the utility meter (or a program-approved sub-meter on the battery) and that the controller can take aggregator dispatch signals and report performance.');
  }

  return notes;
}
