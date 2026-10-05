import { test } from 'node:test';
import assert from 'node:assert/strict';

import { kvaFromAmps, nec120PercentLimit, ampsFromKw } from '../assets/js/engine/electrical.js';
import { optimizeShave, windowMask, designDayProfile, loadFactor } from '../assets/js/engine/loadshape.js';
import { deliverableKw, programStream, resolveConflicts, programEligibility, valueStack } from '../assets/js/engine/value.js';
import { buildConfig, candidateConfigs } from '../assets/js/engine/configs.js';
import { irr, economics } from '../assets/js/engine/finance.js';
import { analyzeSite, resolveAssumptions } from '../assets/js/engine/index.js';
import { data, products, jurisdiction, baseSite } from './fixture.mjs';

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);
const A = resolveAssumptions(data);

test('service kVA and inverter current', () => {
  near(kvaFromAmps(480, 1000, 3), 831.4);
  near(kvaFromAmps(240, 200, 1), 48);
  near(ampsFromKw(200, 480, 3), 240.6);
});

test('NEC 120% rule: 208 V / 800 A busbar / 800 A main allows ~46 kW', () => {
  const r = nec120PercentLimit({ busbarAmps: 800, mainBreakerAmps: 800, volts: 208, phases: 3 });
  near(r.maxBackfeedBreakerAmps, 160);
  near(r.maxInverterAmps, 128);
  near(r.maxInverterKw, 46.1);
});

test('windowMask handles wrap-around windows', () => {
  const m = windowMask(24, 1, { start: 22, end: 2 });
  assert.deepEqual(
    m.map((x, i) => (x ? i : null)).filter((x) => x != null),
    [0, 1, 22, 23],
  );
});

test('optimizeShave: single spike, energy-limited and power-limited', () => {
  const kw = new Array(24).fill(100);
  for (let h = 0; h < 7; h++) kw[h] = 40; // low overnight load leaves recharge room
  kw[14] = 150;
  const profile = { kw, dtHours: 1 };
  const comps = [{ id: 'ncp', rate: 10, window: null }];
  // Enough energy & power for the 50 kW spike; the 5 kWh spare shaves ~0.3 kW off the 17 daytime hours too.
  let r = optimizeShave(profile, comps, { kw: 60, usableKwh: 55, rte: 0.85 });
  near(r.deltas.ncp, 50.3, 0.02);
  // Energy-limited to 20 kWh → ~20 kW.
  r = optimizeShave(profile, comps, { kw: 60, usableKwh: 20, rte: 0.85 });
  near(r.deltas.ncp, 20, 0.03);
  // Power-limited to 30 kW.
  r = optimizeShave(profile, comps, { kw: 30, usableKwh: 100, rte: 0.85 });
  near(r.deltas.ncp, 30, 0.03);
});

test('optimizeShave: recharge cannot create a new peak on a flat profile', () => {
  const profile = { kw: new Array(24).fill(100), dtHours: 1 };
  const r = optimizeShave(profile, [{ id: 'ncp', rate: 10 }], { kw: 50, usableKwh: 200, rte: 0.85 });
  assert.equal(r.deltas.ncp, 0);
});

test('designDayProfile respects peak and custom profiles', () => {
  const p = designDayProfile({ peakKw: 500, annualKwh: 500 * 8760 * 0.45, buildingType: 'office' });
  near(Math.max(...p.kw), 500);
  assert.equal(p.kw.length, 24);
  const c = designDayProfile({ peakKw: 0, custom: new Array(96).fill(10) });
  assert.equal(c.dtHours, 0.25);
  near(loadFactor(100, 438000), 0.5);
});

test('deliverable kW is limited by duration (2.1 h unit for a 3 h event)', () => {
  const cfg = buildConfig([{ productId: 'B200-418', count: 1 }], products);
  near(deliverableKw(cfg, baseSite, A, 3), (418 * 0.9) / 3);
  near(deliverableKw(cfg, baseSite, A, 0), 200);
  // Non-export load cap: tiny site.
  near(deliverableKw(cfg, { ...baseSite, peak_kw: 100 }, A, 0), 85);
});

test('per_kw_season program value and duration flag', () => {
  const cfg = buildConfig([{ productId: 'B200-418', count: 1 }], products);
  const s = programStream(jurisdiction.programs[0], baseSite, cfg, A, {});
  near(s.annual_usd, 200 * ((418 * 0.9) / 3) * 0.9);
  assert.ok(s.flags.includes('duration_short'));
});

test('eligibility: min kW via aggregator, closed programs, territory', () => {
  const small = buildConfig([{ productId: 'B30-150', count: 1 }], products);
  const e = programEligibility(jurisdiction.programs[1], baseSite, small);
  assert.equal(e.eligible, true);
  assert.equal(e.viaAggregator, true);
  assert.equal(programEligibility(jurisdiction.programs[3], baseSite, small).eligible, false);
  assert.equal(programEligibility(jurisdiction.programs[0], { ...baseSite, utility_id: 'other' }, small).eligible, false);
});

test('upfront incentive capped at % of cost', () => {
  const cfg = buildConfig([{ productId: 'B30-150', count: 1 }], products); // cost 90,000
  const s = programStream(jurisdiction.programs[2], baseSite, cfg, A, {});
  near(s.upfront_usd, 15000); // 150 kWh × $100 < 50% cap
  const cheap = buildConfig([{ productId: 'B30-150', count: 1 }], [{ ...products[0], installed_cost_usd_per_kwh: 100 }]);
  near(programStream(jurisdiction.programs[2], baseSite, cheap, A, {}).upfront_usd, 7500);
});

test('conflicting programs: keep the higher-value one', () => {
  const { kept, excluded } = resolveConflicts([
    { program_id: 'a', annual_usd: 100, upfront_usd: 0, conflicts_with: ['b'] },
    { program_id: 'b', annual_usd: 300, upfront_usd: 0, conflicts_with: [] },
  ]);
  assert.deepEqual(kept.map((k) => k.program_id), ['b']);
  assert.equal(excluded[0].program_id, 'a');
});

test('value stack: TOU tariff includes window demand and arbitrage', () => {
  const site = { ...baseSite, tariff_id: 'test-tou' };
  const cfg = buildConfig([{ productId: 'B200-600', count: 1 }], products);
  const vs = valueStack(site, cfg, { tariff: jurisdiction.tariffs[1], programs: [], assumptions: A });
  const cats = vs.streams.map((s) => s.category);
  assert.ok(cats.includes('demand_charge'));
  assert.ok(cats.includes('energy_arbitrage'));
  const onpk = vs.streams.find((s) => s.label.includes('Summer on-peak'));
  assert.deepEqual(onpk.months, [6, 7, 8, 9]);
  assert.ok(onpk.annual_usd > 0);
});

test('fixed supply contract moves tag savings to upside', () => {
  const cfg = buildConfig([{ productId: 'B200-600', count: 1 }], products);
  const vs = valueStack({ ...baseSite, supply_contract: 'fixed_all_in' }, cfg, { tariff: jurisdiction.tariffs[0], programs: [], assumptions: A });
  const cp = vs.streams.find((s) => s.category === 'coincident_peak');
  assert.equal(cp.scenario, 'upside');
});

test('shave override replaces the design-day estimate', () => {
  const cfg = buildConfig([{ productId: 'B65-200', count: 1 }], products);
  const site = { ...baseSite, shave_kw_override: { [cfg.id]: 40 } };
  const vs = valueStack(site, cfg, { tariff: jurisdiction.tariffs[0], programs: [], assumptions: A });
  near(vs.streams[0].annual_usd, 40 * 20 * 12);
});

test('IRR and economics', () => {
  near(irr([-100, 60, 60]), 0.1307, 0.001);
  const e = economics({ capex: 1000, upfront: 300, annual: 200, omPerYear: 0, degradation: 0, discountRate: 0.08, years: 10 });
  near(e.simplePayback, 3.5);
  assert.equal(economics({ capex: null }).npv, null);
});

test('candidate configs stop at the useful kW ceiling', () => {
  const cfgs = candidateConfigs(products, { usefulKwCeiling: 425 });
  const n200 = cfgs.filter((c) => c.items[0].productId === 'B200-418').length;
  assert.equal(n200, 2);
  assert.ok(cfgs.some((c) => c.id === '1xB30-150'));
});

test('analyzeSite end-to-end', () => {
  const a = analyzeSite(baseSite, data);
  assert.ok(a.results.length > 4);
  assert.ok(a.recommended);
  assert.ok(a.score.score >= 0 && a.score.score <= 100);
  assert.ok(a.panel.length > 0);
  assert.ok(a.briefing.some((n) => n.note === 'Utility briefing'));
  // ITC present and computed on cost net of upfront incentive.
  const itc = a.recommended.streams.find((s) => s.program_id === 'fed-itc');
  const otherUpfront = a.recommended.streams.filter((s) => s.program_id && s.program_id !== 'fed-itc' && s.scenario === 'base').reduce((n, s) => n + s.upfront_usd, 0);
  near(itc.upfront_usd, 0.3 * (a.recommended.config.installedCostUsd - otherUpfront));
  // Only one of the conflicting DR programs is kept.
  const dr = a.recommended.streams.filter((s) => s.program_id === 'test-dr' || s.program_id === 'test-dr-alt');
  assert.equal(dr.length, 1);
});

test('constraints: small 208 V service and indoor aggregate limits', () => {
  const site = { ...baseSite, service_voltage: 208, service_amps: 800, busbar_amps: 800, main_breaker_amps: 800, install_location: 'indoor' };
  const a = analyzeSite(site, data);
  const big = a.results.find((r) => r.config.id === '2xB200-418');
  const ids = big.constraints.checks.map((c) => `${c.id}:${c.severity}`);
  assert.ok(ids.includes('nec-120:caution'));
  assert.ok(ids.includes('fire-indoor:critical'));
  assert.equal(big.constraints.status, 'critical');
  // Recommended config must avoid critical issues when a feasible one exists.
  assert.notEqual(a.recommended.constraints.status, 'critical');
});

test('access gate: only exact @sunbeltrentals.com addresses', async () => {
  // access.js imports ui.js, which only touches the DOM inside functions — safe to import in Node.
  const { isAllowedEmail } = await import('../assets/js/access.js');
  assert.equal(isAllowedEmail('jane.doe@sunbeltrentals.com'), true);
  assert.equal(isAllowedEmail('  Jane.Doe@SunbeltRentals.com '), true);
  assert.equal(isAllowedEmail('jane@gmail.com'), false);
  assert.equal(isAllowedEmail('jane@sunbeltrentals.com.evil.io'), false);
  assert.equal(isAllowedEmail('jane@notsunbeltrentals.com'), false);
  assert.equal(isAllowedEmail('@sunbeltrentals.com'), false);
  assert.equal(isAllowedEmail('jane sunbeltrentals.com'), false);
});

// ---- Challenger-review regressions ----
import { eventDayReduction } from '../assets/js/engine/loadshape.js';
import { coincidentStreams, arbitrageStreams, demandChargeStreams, programStream as progStream } from '../assets/js/engine/value.js';
import { yearlyValues } from '../assets/js/engine/finance.js';
import { missingRates } from '../assets/js/engine/index.js';

test('event-day reduction only shaves the peak inside the event block', () => {
  const kw = new Array(24).fill(100);
  kw[12] = 150; // noon peak
  const profile = { kw, dtHours: 1 };
  const comps = [{ id: 'ncp', rate: 10, window: null }];
  near(eventDayReduction(profile, comps, { start: 16, end: 19 }, 50).ncp, 0, 0.001);
  near(eventDayReduction(profile, comps, { start: 11, end: 14 }, 50).ncp, 50, 0.001);
});

test('frequent DR events cap the monthly demand saving', () => {
  const cfg = buildConfig([{ productId: 'B200-600', count: 1 }], products);
  const site = { ...baseSite, building_type: 'restaurant' }; // noon and evening peaks
  const tariff = jurisdiction.tariffs[0];
  const free = demandChargeStreams(site, cfg, tariff, A, designDayProfile({ peakKw: 500, annualKwh: site.annual_kwh, buildingType: 'restaurant' }));
  const ev = demandChargeStreams(site, cfg, tariff, A, designDayProfile({ peakKw: 500, annualKwh: site.annual_kwh, buildingType: 'restaurant' }), [{ program_id: 'x', months: [6, 7, 8, 9], block: { start: 8, end: 11 }, kw: 180 }]);
  assert.ok(ev.streams[0].annual_usd < free.streams[0].annual_usd);
  assert.ok(ev.streams[0].flags.includes('event_days_limit_shave'));
});

test('peak tags: unknown or default-service supply moves tags to upside unless passed through', () => {
  const cfg = buildConfig([{ productId: 'B200-600', count: 1 }], products);
  const t = { id: 't', demand_charges: [], coincident_peak_charges: [{ type: 'plc', est_value_usd_per_kw_year: 100 }, { type: 'nspl', est_value_usd_per_kw_year: 40, default_service_passthrough: true }] };
  const unk = coincidentStreams({ ...baseSite, supply_contract: 'unknown' }, cfg, t, A);
  assert.deepEqual(unk.map((s) => s.scenario), ['upside', 'upside']);
  const def = coincidentStreams({ ...baseSite, supply_contract: 'default_service' }, cfg, t, A);
  assert.deepEqual(def.map((s) => s.scenario), ['upside', 'base']);
  // Tags are capped at site load even when export is allowed.
  const exp = coincidentStreams({ ...baseSite, peak_kw: 100, export_allowed: true }, cfg, t, A);
  assert.ok(exp[0].kw_used <= 100 * A.event_load_fraction * A.cp_hit_rate + 1e-9);
});

test('arbitrage excludes energy already spent shaving outside the TOU window', () => {
  const kw = new Array(24).fill(60);
  for (let h = 9; h < 15; h++) kw[h] = 100; // midday plateau outside 16-21
  const profile = { kw, dtHours: 1 };
  const cfg = buildConfig([{ productId: 'B65-200', count: 1 }], products);
  const t = { id: 't', demand_charges: [{ label: 'NCP', rate_usd_per_kw_month: 20, basis: 'ncp_monthly', months: [] }], arbitrage: [{ months: [6], peak_window: { start: 16, end: 21 }, peak_price: 0.3, offpeak_price: 0.1, days: 'all' }] };
  const d = demandChargeStreams(baseSite, cfg, t, A, profile);
  const withShave = arbitrageStreams(baseSite, cfg, t, A, profile, d.monthOpt);
  const alone = arbitrageStreams(baseSite, cfg, t, A, profile, {});
  // All usable energy goes to the midday shave, so arbitrage is fully displaced (stream dropped) or reduced.
  assert.ok((withShave[0]?.annual_usd ?? 0) < alone[0].annual_usd);
});

test('ratchet: off-season months valued at the ratchet percentage', () => {
  const cfg = buildConfig([{ productId: 'B65-200', count: 1 }], products);
  const site = { ...baseSite, shave_kw_override: { [cfg.id]: 10 } };
  const t = { id: 't', ratchet: { pct: 0.8 }, demand_charges: [{ label: 'Dist', rate_usd_per_kw_month: 10, basis: 'ratchet', months: [] }] };
  const d = demandChargeStreams(site, cfg, t, A, designDayProfile({ peakKw: 500, annualKwh: site.annual_kwh }));
  near(d.streams[0].annual_usd, 10 * 10 * (4 + 0.8 * 8));
});

test('program minimum compares deliverable kW for the event duration', () => {
  const cfg = buildConfig([{ productId: 'B65-200', count: 1 }], products); // 180 kWh usable / 4 h = 45 kW
  const p = { id: 'csrp', name: 'CSRP', category: 'demand_response', status: 'open', eligibility: { min_kw: 50 }, valuation: { method: 'per_kw_month', rate: 18, months_per_year: 5, duration_basis_hr: 4 } };
  assert.equal(progStream(p, baseSite, cfg, A, {}), null);
  const agg = { ...p, eligibility: { min_kw: 50, aggregation_allowed: true } };
  assert.ok(progStream(agg, baseSite, cfg, A, {}).flags.includes('aggregator_required'));
});

test('ITC: upside until FEOC confirmed; 6% at >= 1 MW without PWA', () => {
  const itc = { id: 'itc', name: 'ITC', category: 'tax', status: 'open', feoc_applies: true, valuation: { method: 'pct_of_cost', rate: 0.3, pwa_threshold_kw: 1000, rate_without_pwa: 0.06 } };
  const small = buildConfig([{ productId: 'B200-418', count: 1 }], products);
  assert.equal(progStream(itc, baseSite, small, { ...A, itc_feoc_confirmed: false }, {}).scenario, 'upside');
  assert.equal(progStream(itc, baseSite, small, { ...A, itc_feoc_confirmed: true }, {}).scenario, 'base');
  const big = buildConfig([{ productId: 'B200-600', count: 5 }], products);
  near(progStream(itc, { ...baseSite, peak_kw: 2000 }, big, { ...A, itc_feoc_confirmed: true, itc_pwa_confirmed: false }, {}).upfront_usd, 0.06 * big.installedCostUsd);
});

test('spread payments, confirmations and post-term value', () => {
  const abate = { id: 'abate', name: 'Abatement', category: 'tax', status: 'open', eligibility: { requires_property_owner: true }, valuation: { method: 'pct_of_cost', rate: 0.3, cap_usd: 250000, spread_years: 4 } };
  const cfg = buildConfig([{ productId: 'B200-418', count: 1 }], products);
  const s = progStream(abate, baseSite, cfg, A, {});
  assert.equal(s.upfront_usd, 0);
  near(s.annual_usd, (0.3 * cfg.installedCostUsd) / 4);
  assert.equal(s.scenario, 'upside');
  assert.equal(progStream(abate, { ...baseSite, property_owner: true }, cfg, A, {}).scenario, 'base');
  const y = yearlyValues([{ ...s, scenario: 'base' }], { years: 6, degradationPct: 2 });
  near(y[0], y[3]);
  assert.equal(y[4], 0);
  const conf = { id: 'c', name: 'C', category: 'performance_incentive', status: 'open', requires_confirmation: 'unverified', valuation: { method: 'per_kw_year', rate: 100, duration_basis_hr: 2 } };
  assert.equal(progStream(conf, baseSite, cfg, A, {}).scenario, 'upside');
  assert.equal(progStream(conf, { ...baseSite, confirmed_programs: { c: true } }, cfg, A, {}).scenario, 'base');
  const lock = yearlyValues([{ annual_usd: 100, scenario: 'base', category: 'performance_incentive', term_years: 5, rate: 1 }], { years: 7, degradationPct: 0, postTermFactor: 0.5 });
  assert.deepEqual(lock.map(Math.round), [100, 100, 100, 100, 100, 50, 50]);
});

test('missing rates are reported and site-size filters apply', () => {
  const t = { id: 't', demand_charges: [{ label: 'A', rate_usd_per_kw_month: null, basis: 'ncp_monthly' }, { label: 'B', rate_usd_per_kw_month: null, basis: 'ncp_monthly', max_site_peak_kw: 700 }], coincident_peak_charges: [{ type: '4cp', est_value_usd_per_kw_year: null, min_site_peak_kw: 700 }] };
  assert.deepEqual(missingRates(t, { peak_kw: 400 }), ['A', 'B']);
  assert.deepEqual(missingRates(t, { peak_kw: 900 }), ['A', 'peak tag: 4cp']);
});

test('Option S minimum storage share is enforced as a critical check', () => {
  const tariff = { ...jurisdiction.tariffs[1], id: 'opt-s', applicability: { min_storage_kw_pct_of_peak: 0.1 } };
  const d = { ...data, jurisdictions: { TEST: { ...jurisdiction, tariffs: [...jurisdiction.tariffs, tariff] } } };
  const a = analyzeSite({ ...baseSite, peak_kw: 700, tariff_id: 'opt-s' }, d);
  const small = a.results.find((r) => r.config.id === '1xB30-150');
  assert.equal(small.constraints.status, 'critical');
  assert.ok(a.recommended.config.kw >= 70);
});

test('optimizer stops when shaving costs more in losses than it saves', () => {
  const kw = new Array(24).fill(50);
  for (let h = 8; h < 20; h++) kw[h] = 100; // 12-hour flat plateau: shaving needs ~12 kWh per kW
  const profile = { kw, dtHours: 1 };
  const comps = [{ id: 'ncp', rate: 2, window: null }];
  const free = optimizeShave(profile, comps, { kw: 60, usableKwh: 120, rte: 0.85 });
  const costly = optimizeShave(profile, comps, { kw: 60, usableKwh: 120, rte: 0.85, energyCostPerKwhMonth: (1 / 0.85 - 1) * 0.25 * 21 });
  assert.ok(free.deltas.ncp > 5);
  assert.equal(costly.deltas.ncp, 0);
});

// ---- Event-day residual shaving and dispatch strategy ----
import { eventBlockFor } from '../assets/js/engine/value.js';

test('event day: leftover battery energy still shaves a peak outside the event block', () => {
  // 100 kW by day, 50 kW overnight (room to recharge), noon peak; event at 4-7pm.
  const kw = Array.from({ length: 24 }, (_, h) => (h >= 7 && h < 22 ? 100 : 50));
  kw[12] = 150;
  const profile = { kw, dtHours: 1 };
  const comps = [{ id: 'ncp', rate: 10, window: null }];
  const block = { start: 16, end: 19 };
  // 50 kW × 3 h = 150 kWh for the event; 300 kWh usable leaves energy to shave noon.
  const withEnergy = eventDayReduction(profile, comps, block, 50, { kw: 100, usableKwh: 300, rte: 0.85 }).ncp;
  assert.ok(withEnergy >= 49.5, `leftover energy shaves the noon spike (got ${withEnergy})`);
  near(eventDayReduction(profile, comps, block, 50).ncp, 0, 0.001); // legacy: event discharge only
  // On a flat 24 h load there is no room to recharge the event energy without a new peak.
  const flat = new Array(24).fill(100);
  flat[12] = 150;
  assert.ok(eventDayReduction({ kw: flat, dtHours: 1 }, comps, block, 50, { kw: 100, usableKwh: 300, rte: 0.85 }).ncp < 45);
  // No energy left after the event: no shave outside the block.
  near(eventDayReduction(profile, comps, block, 50, { kw: 100, usableKwh: 150, rte: 0.85 }).ncp, 0, 0.001);
  // kW fully committed to the event cannot also discharge inside the block.
  const kw2 = new Array(24).fill(100);
  kw2[17] = 160;
  const r = eventDayReduction({ kw: kw2, dtHours: 1 }, comps, block, 50, { kw: 50, usableKwh: 400, rte: 0.85 });
  near(r.ncp, 50, 0.02);
});

test('dispatch strategy: skip a DR program whose events cost more demand savings than it pays', () => {
  const cfg = buildConfig([{ productId: 'B30-150', count: 1 }], products);
  const site = { ...baseSite, peak_kw: 400, building_type: 'retail' };
  const tariff = { id: 't', demand_charges: [{ label: 'NCP', basis: 'ncp_monthly', rate_usd_per_kw_month: 45, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }] };
  const prog = (rate) => ({
    id: 'dr', name: 'Test DR (TDR)', category: 'demand_response', status: 'open', utility_ids: [], confidence: 'high',
    eligibility: {}, valuation: { method: 'per_kw_month', rate, months_per_year: 5, duration_basis_hr: 4 },
    dispatch: { event_duration_hr: 4, event_months: [5, 6, 7, 8, 9], event_block: { start: 19, end: 23 } },
  });
  const cheap = valueStack(site, cfg, { tariff, programs: [prog(2)], assumptions: A });
  assert.ok(cheap.strategy, 'low-paying program is skipped');
  assert.deepEqual(cheap.strategy.skipped_ids, ['dr']);
  assert.ok(cheap.excluded.some((s) => s.program_id === 'dr' && /Not enrolled/.test(s.excluded_reason)));
  assert.ok(!cheap.streams.some((s) => s.program_id === 'dr'));
  assert.ok(cheap.strategy.net_gain_usd > 0);
  const rich = valueStack(site, cfg, { tariff, programs: [prog(200)], assumptions: A });
  assert.equal(rich.strategy, null, 'high-paying program stays enrolled');
  assert.ok(rich.streams.some((s) => s.program_id === 'dr'));
});

test('event window: site selection must be one of the program options', () => {
  const p = { dispatch: { event_block: { start: 14, end: 18 }, event_block_options: [{ start: 11, end: 15 }, { start: 14, end: 18 }] } };
  assert.deepEqual(eventBlockFor(p, { event_blocks: { x: '11-15' } }), { start: 14, end: 18 });
  assert.deepEqual(eventBlockFor({ id: 'x', ...p }, { event_blocks: { x: '11-15' } }), { start: 11, end: 15 });
  assert.deepEqual(eventBlockFor({ id: 'x', ...p }, { event_blocks: { x: '9-13' } }), { start: 14, end: 18 });
});

// ---- Workbench interchange and interval-data shaving ----
import { decodeRaw, buildInterval, lmParts, siteFromWorkbench, mergeAtlasIntoWorkbench, workbenchConfigId, marketFor } from '../assets/js/workbench.js';
import { deepenAcrossDays, componentPeaks, dayUnderCaps } from '../assets/js/engine/loadshape.js';
import { makeWorkbenchSite } from './workbench-fixture.mjs';

const WB = makeWorkbenchSite({ peakKw: 400, utility: 'National Grid' });
const IV = buildInterval(decodeRaw(WB.raw));

test('workbench raw block decodes to wall-clock 15-minute data', () => {
  const dec = decodeRaw(WB.raw);
  assert.equal(dec.kw.length, 365 * 96);
  assert.deepEqual(lmParts(dec.stamps[0]), { y: 2025, mo: 0, d: 1, h: 0, mi: 0 });
  assert.deepEqual(lmParts(dec.stamps.at(-1)), { y: 2025, mo: 11, d: 31, h: 23, mi: 45 });
  assert.equal(decodeRaw({ ...WB.raw, n: WB.raw.n + 1 }), null, 'inconsistent block is rejected');
  assert.equal(IV.monthsCovered, 12);
  assert.equal(IV.months[7].days.length, 31);
  near(IV.peak_kw, Math.max(...WB.raw.kw), 1e-9);
  assert.ok(IV.annual_kwh > 1e6 && IV.annual_kwh < 3e6);
});

test('monthly caps from interval data match a brute-force all-days search (single NCP charge)', () => {
  const md = IV.months[7];
  const env = { kw: md.envelope, dtHours: IV.dtHours };
  const comps = [{ id: 'ncp', rate: 10, window: null }];
  const battery = { kw: 30, chargeKw: 30, usableKwh: 130.2, rte: 0.8836 };
  const opt = optimizeShave(env, comps, battery);
  const deep = deepenAcrossDays(md.days, env, comps, opt.deltas, battery);
  // Brute force: the lowest cap that every day can hold.
  const peak = componentPeaks(env, comps).ncp;
  let lo = peak - battery.kw;
  let hi = peak;
  for (let k = 0; k < 40; k++) {
    const cap = (lo + hi) / 2;
    const caps = new Array(96).fill(cap);
    if (md.days.every((d) => dayUnderCaps(d.kw, caps, IV.dtHours, battery).ok)) hi = cap;
    else lo = cap;
  }
  near(deep.deltas.ncp, peak - hi, 0.02);
  assert.ok(deep.deltas.ncp >= opt.deltas.ncp - 1e-9, 'deepening never loses reduction found on the envelope');
});

test('interval-based demand savings hold on every day and are labelled as such', () => {
  const site = { ...baseSite, peak_kw: IV.peak_kw, annual_kwh: IV.annual_kwh, energy_price: 0.2 };
  const cfg = buildConfig([{ productId: 'B30-150', count: 1 }], products);
  const tariff = { id: 't', demand_charges: [{ label: 'NCP', basis: 'ncp_monthly', rate_usd_per_kw_month: 15, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }] };
  const r = demandChargeStreams(site, cfg, tariff, A, designDayProfile({ peakKw: site.peak_kw, annualKwh: site.annual_kwh, buildingType: 'retail' }), [], IV);
  assert.equal(r.intervalMonths, 12);
  assert.match(r.streams[0].basis_text, /interval data, held on every day of each month/);
  // The realized caps (after capture) hold on every day of every month.
  const usable = cfg.usableKwh ?? cfg.kwh * A.usable_fraction;
  for (const [m, md] of Object.entries(IV.months)) {
    const caps = r.monthOpt[m].caps;
    assert.ok(md.days.every((d) => dayUnderCaps(d.kw, caps, IV.dtHours, { kw: cfg.kw, usableKwh: usable, rte: A.rte_ac }).ok), `month ${m}`);
  }
  assert.ok(r.cyclingKwhPerYear > 0);
});

test('slower charging (65/200 charges at 40 kW) never increases the shave', () => {
  const env = { kw: IV.months[7].envelope, dtHours: IV.dtHours };
  const comps = [{ id: 'ncp', rate: 10, window: null }];
  const fast = optimizeShave(env, comps, { kw: 65, chargeKw: 65, usableKwh: 173.6, rte: 0.8836 });
  const slow = optimizeShave(env, comps, { kw: 65, chargeKw: 5, usableKwh: 173.6, rte: 0.8836 });
  assert.ok(slow.deltas.ncp < fast.deltas.ncp, 'a 5 kW charger cannot refill the battery overnight');
});

test('workbench site maps onto an Atlas site; results merge back without touching workbench keys', () => {
  const realData = { jurisdictions: { MA: { code: 'MA', utilities: [{ id: 'ngrid-ma', name: 'National Grid (Massachusetts Electric Company)' }, { id: 'eversource-ma', name: 'Eversource (NSTAR Electric)' }] } } };
  const imp = siteFromWorkbench(WB, IV, realData);
  assert.equal(imp.patch.jurisdiction, 'MA');
  assert.equal(imp.patch.utility_id, 'ngrid-ma');
  assert.equal(imp.patch.service_voltage, 480);
  near(imp.patch.peak_kw, IV.peak_kw, 0.01);
  assert.equal(imp.workbench.selectedConfigId, '1xB65-200');
  assert.equal(workbenchConfigId({ mix: [{ id: '30/150', n: 2 }, { id: 'RPS1200', n: 1 }] }), null, 'unmapped units are not guessed');
  assert.equal(marketFor({ iso: 'PSEG-LI', addr: 'Islip, NY' }).code, null);
  assert.equal(marketFor({ iso: 'NYISO', addr: '1 Main St, Brooklyn, NY 11201' }).code, 'NY-NYC');
  const merged = mergeAtlasIntoWorkbench(WB, { version: 1, recommended: { config_id: '1xB65-200' } });
  assert.equal(merged.raw, WB.raw, 'interval data preserved by reference');
  assert.deepEqual(merged.someSiblingToolKey, { keep: true });
  assert.equal(merged.atlas.recommended.config_id, '1xB65-200');
  assert.equal(WB.atlas, undefined, 'original not mutated');
});

// ---- Savings tab: per-month detail, workbench-equivalent hold, interval-by-interval dispatch ----
import { simulateDay } from '../assets/js/engine/loadshape.js';
import { allHoursHolds, simBatteryOf } from '../assets/js/engine/value.js';

test('simulateDay: holds a cap it has energy for, misses one it does not', () => {
  const kw = new Array(24).fill(100);
  kw[13] = 140;
  kw[14] = 140;
  const bat = { kw: 50, chargeKw: 50, storedKwh: 100, effCharge: 0.94, effDischarge: 0.94 };
  const ok = simulateDay(kw, kw.map(() => 110), 1, bat);
  assert.ok(ok.held);
  near(ok.peakAfter, 110, 1e-6);
  near(ok.energyUsed, 60, 1e-6);
  near(ok.lowestSoc, 100 - 60 / 0.94, 1e-6);
  // 100 kWh stored × 0.94 = 94 kWh deliverable < 2 h × 60 kW needed for a 80 kW cap
  const miss = simulateDay(kw, kw.map(() => 80), 1, bat);
  assert.equal(miss.held, false);
  assert.ok(miss.peakAfter > 80);
});

test('per-month detail: sustainable hold matches an all-days brute force; dollars add up to the stream', () => {
  const cfg = buildConfig([{ productId: 'B65-200', count: 1 }], [{ id: 'B65-200', label: '65/200', kw: 65, kwh: 200, usable_kwh: 173.6, charge_kw: 40, eff_charge: 0.94, eff_discharge: 0.94, installed_cost_usd: 200000 }]);
  const site = { ...baseSite, peak_kw: IV.peak_kw, annual_kwh: IV.annual_kwh, energy_price: 0.2 };
  const profile = designDayProfile({ peakKw: site.peak_kw, annualKwh: site.annual_kwh, buildingType: 'retail' });
  const holds = allHoursHolds(site, cfg, A, profile, IV);
  // Brute force for August with the same battery, all days, AC deliverable = stored × discharge efficiency.
  const md = IV.months[8];
  const battery = { kw: 65, chargeKw: 40, usableKwh: 173.6 * 0.94, rte: 0.94 * 0.94 };
  let lo = Math.max(...md.envelope) - 65;
  let hi = Math.max(...md.envelope);
  for (let k = 0; k < 40; k++) {
    const cap = (lo + hi) / 2;
    if (md.days.every((d) => dayUnderCaps(d.kw, new Array(96).fill(cap), IV.dtHours, battery).ok)) hi = cap;
    else lo = cap;
  }
  near(holds[8], hi, 0.02);
  const tariff = { id: 't', demand_charges: [{ label: 'NCP', basis: 'ncp_monthly', rate_usd_per_kw_month: 15, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }] };
  const r = demandChargeStreams(site, cfg, tariff, A, profile, [], IV);
  const total = Object.values(r.monthDetail).reduce((n, d) => n + d.usd, 0);
  near(total, r.streams[0].annual_usd, 1e-6);
  const aug = r.monthDetail[8];
  assert.equal(aug.basis, 'interval');
  assert.equal(aug.daysTotal, 31);
  assert.equal(aug.daysHeld, 31, 'the planned target holds every day');
  near(aug.comps[0].reduction, (aug.comps[0].peak - aug.comps[0].hold) * A.shave_capture, 1e-6);
  // The battery the simulation uses carries the product specs.
  const sb = simBatteryOf(cfg, A);
  near(sb.storedKwh, 173.6, 1e-9);
  near(sb.effDischarge, 0.94, 1e-9);
  assert.equal(sb.chargeKw, 40);
});

// ---- Hawaii-driven engine features: billing-demand floor, flat energy adder, solar-paired program rate ----
import { billingFloor } from '../assets/js/engine/value.js';

test('minimum billing demand: shaving below the floor does not lower the bill', () => {
  const cfg = buildConfig([{ productId: 'B200-600', count: 1 }], products);
  const site = { ...baseSite, peak_kw: 320, annual_kwh: 320 * 8760 * 0.5, energy_price: 0.3 };
  const profile = designDayProfile({ peakKw: 320, annualKwh: site.annual_kwh, buildingType: 'retail' });
  const mk = (floor) => ({ id: 't', min_billing_demand_kw: floor, demand_charges: [{ label: 'NCP', basis: 'ncp_monthly', rate_usd_per_kw_month: 30, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }] });
  const free = demandChargeStreams(site, cfg, mk(null), A, profile);
  const floored = demandChargeStreams(site, cfg, mk(300), A, profile);
  assert.equal(billingFloor({}, mk(300)), 300);
  assert.equal(billingFloor({ min_billing_demand_kw: 50 }, mk(300)), 50, 'charge-level floor wins');
  // Peak 320 kW with a 300 kW floor: at most 20 kW of reduction is billable per month.
  assert.ok(floored.streams[0].kw_used <= 20 + 1e-6, `kw_used ${floored.streams[0].kw_used}`);
  assert.ok(floored.streams[0].annual_usd < free.streams[0].annual_usd);
  assert.ok(floored.streams[0].flags.includes('min_billing_demand'));
  assert.ok(!free.streams[0].flags.includes('min_billing_demand'));
});

test('flat energy adder raises the cost of round-trip losses but not the spread', () => {
  const cfg = buildConfig([{ productId: 'B65-200', count: 1 }], products);
  const profile = designDayProfile({ peakKw: 500, annualKwh: baseSite.annual_kwh, buildingType: 'office' });
  const tariff = (adder) => ({ id: 'a', energy_adder_usd_per_kwh: adder, demand_charges: [], arbitrage: [{ label: 'All', months: [], peak_window: { start: 17, end: 22 }, peak_price: 0.10, offpeak_price: 0.02, days: 'all' }] });
  const none = arbitrageStreams(baseSite, cfg, tariff(0), A, profile)[0];
  const adder = arbitrageStreams(baseSite, cfg, tariff(0.25), A, profile)[0];
  assert.ok(adder.annual_usd < none.annual_usd, 'losses cost more at a higher all-in price');
  // Per kWh discharged: peak − offpeak/RTE, so the adder lowers it by adder × (1/RTE − 1).
  const rte = cfg.rte ?? A.rte_ac;
  const drop = (none.annual_usd - adder.annual_usd) / none.annual_usd;
  assert.ok(drop > 0.2 && drop < 0.6, `drop ${drop}`);
  // A site-level override wins over the tariff's adder.
  const overridden = arbitrageStreams({ ...baseSite, energy_adder_usd_per_kwh: 0 }, cfg, tariff(0.25), A, profile)[0];
  near(overridden.annual_usd, none.annual_usd, 1e-9);
  void rte;
});

test('program rate with paired solar applies only when the site has solar', () => {
  const cfg = buildConfig([{ productId: 'B65-200', count: 1 }], products);
  const prog = { id: 'ps', name: 'Solar-tiered rebate', category: 'upfront_incentive', status: 'open', utility_ids: [], confidence: 'medium', eligibility: {}, valuation: { method: 'upfront_per_kwh', rate: 150, rate_with_solar: 250 } };
  const without = programStream(prog, { ...baseSite, has_solar: false }, cfg, A, {});
  const withSolar = programStream(prog, { ...baseSite, has_solar: true }, cfg, A, {});
  near(without.upfront_usd, 150 * cfg.kwh, 1e-9);
  near(withSolar.upfront_usd, 250 * cfg.kwh, 1e-9);
  assert.match(withSolar.notes, /paired solar/i);
  const overridden = programStream(prog, { ...baseSite, has_solar: true, program_rate_overrides: { ps: 100 } }, cfg, A, {});
  near(overridden.upfront_usd, 100 * cfg.kwh, 1e-9);
});

// ---- Hawaii data regression (real data/jurisdictions/hi.json) ----
import { loadAll } from '../scripts/validate-data.mjs';
const REAL = loadAll();
const hiSite = (over) => ({ jurisdiction: 'HI', utility_id: 'hawaiian-electric', tariff_id: 'heco-sch-p', building_type: 'retail', peak_kw: 450, annual_kwh: 450 * 8760 * 0.5, service_voltage: 480, phases: 3, service_amps: 1200, busbar_amps: 1200, main_breaker_amps: 1200, network_secondary: 'no', install_location: 'outdoor_ground', supply_contract: 'unknown', setback_ok: 'yes', energy_price: 0.36, ...over });
const settingsFeoc = { assumptions: { itc_feoc_confirmed: true } };

test('Hawaii is a market with its own utilities, tariffs and persona', () => {
  assert.ok(REAL.manifest.jurisdictions.some((j) => j.code === 'HI'));
  const hi = REAL.jurisdictions.HI;
  assert.deepEqual(hi.utilities.map((u) => u.id).sort(), ['hawaii-electric-light', 'hawaiian-electric', 'kiuc', 'maui-electric']);
  assert.ok(REAL.panel.personas.some((p) => p.id === 'heco' && p.utility_ids.includes('kiuc')));
  assert.equal(hi.utilities.every((u) => u.retail_choice === false), true);
  assert.ok(hi.tariffs.every((t) => (t.coincident_peak_charges || []).length === 0), 'no capacity or transmission tags in Hawaii');
});

test('Hawaii Schedule P: 300 kW minimum billing demand caps the billable shave', () => {
  const a = analyzeSite(hiSite({ peak_kw: 305, annual_kwh: 305 * 8760 * 0.5 }), REAL, settingsFeoc);
  const demand = a.recommended.streams.find((s) => s.category === 'demand_charge');
  assert.ok(demand.kw_used <= 5 + 1e-6, `only ${305 - 300} kW is billable, got ${demand.kw_used}`);
  assert.ok(demand.flags.includes('min_billing_demand'));
  const big = analyzeSite(hiSite({ peak_kw: 900, annual_kwh: 900 * 8760 * 0.5 }), REAL, settingsFeoc);
  assert.ok(!big.recommended.streams.find((s) => s.category === 'demand_charge').flags.includes('min_billing_demand'));
});

test('Hawaii programs: eligibility by island, solar tier, and no double-paying the same kW', () => {
  const oahu = analyzeSite(hiSite({ tariff_id: 'heco-sch-j', peak_kw: 200, annual_kwh: 200 * 8760 * 0.5, has_solar: false }), REAL, settingsFeoc);
  const labels = (a, cfgId) => a.results.find((r) => r.config.id === cfgId).streams.map((s) => s.program_id).filter(Boolean);
  assert.ok(labels(oahu, '1xB65-200').includes('hi-fast-dr'), 'Fast DR counts at 65 kW (>= 50 kW)');
  assert.ok(!labels(oahu, '1xB30-150').includes('hi-fast-dr'), '30 kW is below the 50 kW minimum');
  assert.ok(!labels(oahu, '1xB65-200').includes('hi-byod-plus'), 'BYOD Plus needs paired solar');
  const noSolar = oahu.results.find((r) => r.config.id === '1xB65-200').streams.find((s) => s.program_id === 'hi-hawaii-energy-power-move-ces');
  near(noSolar.upfront_usd, 150 * 200, 1e-9);
  const solar = analyzeSite(hiSite({ tariff_id: 'heco-sch-j', peak_kw: 200, annual_kwh: 200 * 8760 * 0.5, has_solar: true }), REAL, settingsFeoc);
  const sol = solar.results.find((r) => r.config.id === '1xB65-200').streams;
  near(sol.find((s) => s.program_id === 'hi-hawaii-energy-power-move-ces').upfront_usd, 250 * 200, 1e-9);
  const both = ['hi-fast-dr', 'hi-byod-plus'].filter((id) => sol.some((s) => s.program_id === id));
  assert.equal(both.length, 1, 'Fast DR and BYOD Plus are treated as exclusive until confirmed');
  // Hawaii Island and Kauai are outside the Oahu/Maui programs.
  const helco = analyzeSite(hiSite({ utility_id: 'hawaii-electric-light', tariff_id: 'helco-sch-p', has_solar: true }), REAL, settingsFeoc);
  assert.ok(!helco.recommended.streams.some((s) => s.program_id === 'hi-hawaii-energy-power-move-ces' || s.program_id === 'hi-fast-dr'));
});

test('Hawaii TOU-J arbitrage uses the fuel-charge adder for round-trip losses', () => {
  const a = analyzeSite(hiSite({ tariff_id: 'heco-tou-j', peak_kw: 200, annual_kwh: 200 * 8760 * 0.5 }), REAL, settingsFeoc);
  const arb = a.results.find((r) => r.config.id === '1xB65-200').streams.find((s) => s.category === 'energy_arbitrage');
  assert.ok(arb, 'TOU-J has an arbitrage stream');
  assert.match(arb.basis_text, /\$0\.3318 peak/);
  assert.match(arb.basis_text, /\$0\.2518/);
});

test('Hawaii: tariffs with no found rate are reported missing, not valued at zero', () => {
  const a = analyzeSite(hiSite({ utility_id: 'maui-electric', tariff_id: 'meco-sch-p', peak_kw: 400 }), REAL, settingsFeoc);
  assert.ok(a.missing.length > 0);
  assert.equal(a.recommended.streams.filter((s) => s.category === 'demand_charge').length, 0);
});

test('workbench: Hawaii addresses and utility names map to the HI market', () => {
  assert.equal(marketFor({ iso: '', addr: '1 Beach Rd, Honolulu, HI 96815' }).code, 'HI');
  assert.equal(marketFor({ iso: 'Hawaiian Electric', addr: '' }).code, 'HI');
});
