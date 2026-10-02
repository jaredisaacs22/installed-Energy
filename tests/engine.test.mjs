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
