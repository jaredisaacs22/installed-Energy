// Cost-free demand savings (engine/demand-savings.js). The bill model is the Site Analysis Workbench's
// dispatchSavings; the expected figures below are what the original workbench file reports for the same
// synthetic site (tests/workbench-fixture.mjs, peak 300 kW, seed 7), the same 65 kW / 173.6 kWh battery and
// the same bills, generated in a real browser. A change that moves one of them is a change from the workbench.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeRaw, buildInterval } from '../assets/js/workbench.js';
import * as H from '../assets/js/engine/hold.js';
import * as DS from '../assets/js/engine/demand-savings.js';
import { makeWorkbenchSite } from './workbench-fixture.mjs';
import { analyzeSite } from '../assets/js/engine/index.js';
import { data as fixtureData, baseSite } from './fixture.mjs';

const iv = buildInterval(decodeRaw(makeWorkbenchSite({ peakKw: 300, seed: 7 }).raw));
const u = { kw: 65, chargeKw: 40, usableKwh: 173.6, effC: 0.94, effD: 0.94, reserve: 0 };
const opt = { sched: null, carry: false };
const holds = H.monthlyHolds(iv, null, u, opt);
const held = (m, t, x) => DS.heldAt(iv, m, t, x, u, opt);
// Billed at the metered peak + 2 kW; $18/kW Jun–Sep, $12/kW otherwise.
const bills = { months: Object.fromEntries(Object.entries(holds).map(([m, x]) => {
  const kw = Math.round((x.peak + 2) * 10) / 10;
  return [m, { kw, usd: kw * (m >= 6 && m <= 9 ? 18 : 12) }];
})) };
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('bill model: monthly savings match the workbench (billed before − held peak) × $/kW', () => {
  const res = DS.billSavings({ holds, bills, held });
  near(res.total, 8577);
  const want = { 1: [234.7, 205, 12, 356.4], 6: [279.3, 227, 18, 941.4], 9: [302, 235, 18, 1206], 12: [266.6, 210, 12, 679.2] };
  for (const [m, [before, after, rate, usd]] of Object.entries(want)) {
    const r = res.rows.find((x) => x.m === +m);
    near(r.before, before);
    near(r.after, after);
    near(r.rate, rate);
    near(r.savings, usd, 1e-3);
  }
  assert.equal(res.entered, 12);
  assert.equal(res.estimated, 0);
});

test('bill model: a target below the sustainable hold is billed at the peak actually held (workbench figures)', () => {
  const t = holds[7].achievable - 10;
  const res = DS.billSavings({ holds, bills, targets: { 7: t }, held });
  const jul = res.rows.find((x) => x.m === 7);
  near(jul.held, 268.8);
  near(jul.after, 268.8);
  near(jul.savings, 187.2, 1e-3);
  near(res.total, 7797.6, 1e-3);
  // above the hold the battery holds the target exactly
  const up = DS.billSavings({ holds, bills, targets: { 7: holds[7].achievable + 5 }, held }).rows.find((x) => x.m === 7);
  near(up.held, holds[7].achievable + 5);
});

test('bill model: the ratchet floor bills each month at no less than ratchet % × the year’s highest held peak', () => {
  const res = DS.billSavings({ holds, bills, ratchetPct: 0.8, held });
  near(res.floor, 188); // 0.8 × 235 (September's hold), as the workbench reports
  const deep = DS.billSavings({ holds, bills, ratchetPct: 1, held });
  near(deep.floor, 235);
  for (const r of deep.rows) near(r.after, Math.max(r.held, 235));
  assert.ok(deep.total < res.total, 'a 100% ratchet keeps every month billed at the annual peak held');
});

test('bill model: blank billed kW uses the metered peak, and months without charges use the average $/kW (flagged)', () => {
  const partial = { months: { 7: { usd: 279.2 * 18, kw: 279.2 }, 8: { usd: 4000, kw: null } } };
  const res = DS.billSavings({ holds, bills: partial, held });
  const aug = res.rows.find((x) => x.m === 8);
  near(aug.before, holds[8].peak);
  near(aug.rate, 4000 / holds[8].peak);
  const jan = res.rows.find((x) => x.m === 1);
  assert.equal(jan.estimated, true);
  near(jan.rate, (18 + 4000 / holds[8].peak) / 2);
  assert.equal(res.entered, 2);
  assert.equal(res.estimated, 10);
});

test('bill model: one $/kW for every month without its own charges', () => {
  const res = DS.billSavings({ holds, bills: { months: { 9: { usd: 302 * 20, kw: 302 } }, flatRate: 12 }, held });
  near(res.rows.find((x) => x.m === 9).rate, 20);
  const jan = res.rows.find((x) => x.m === 1);
  near(jan.rate, 12);
  assert.equal(jan.flat, true);
  assert.equal(jan.estimated, false);
  near(jan.savings, (holds[1].peak - holds[1].achievable) * 12);
  assert.equal(res.estimated, 0);
  assert.equal(DS.usesBills({ bills: { use: true, rate_usd_per_kw: 15 } }), true);
});

test('bills on a site: cleaned, used only when chosen and some charges are entered', () => {
  assert.equal(DS.usesBills({}), false);
  assert.equal(DS.usesBills({ bills: { use: true, months: {} } }), false);
  assert.equal(DS.usesBills({ bills: { use: false, months: { 1: { usd: 100 } } } }), false);
  assert.equal(DS.usesBills({ bills: { use: true, months: { 1: { usd: '100' } } } }), true);
  const b = DS.billsOf({ bills: { use: true, ratchet_pct: 150, months: { 2: { usd: '', kw: '210' }, 3: { usd: 'x' } } } });
  assert.deepEqual(b.months, { 2: { usd: null, kw: 210 } });
  assert.equal(b.ratchetPct, 1);
  assert.equal(DS.tariffRatchet({ ratchet: { pct: 0.8 } }), 0.8);
  assert.equal(DS.tariffRatchet({}), 0);
});

test('design day: billed kW scales each month’s design day, so a lighter month still gets its own cut', () => {
  const profile = { kw: Array.from({ length: 24 }, (_, h) => 100 + (h >= 12 && h < 18 ? 60 : 0)), dtHours: 1 };
  const flat = H.monthlyHolds(null, profile, u, opt);
  const scaled = H.monthlyHolds(null, profile, u, opt, { 1: 80, 7: 160 });
  assert.equal(scaled[7].peak, 160);
  assert.equal(scaled[7].achievable, flat[7].achievable, 'unscaled where the bill matches the design peak');
  near(scaled[1].peak, 80);
  assert.ok(scaled[1].achievable < 80 && scaled[1].achievable > 0);
  assert.equal(scaled[2].achievable, flat[2].achievable, 'months without a bill keep the design day');
});

test('knee pick: the smallest system within 3 points of the deepest average monthly cut', () => {
  const R = (id, kwh, kw, pct) => ({ config: { id, kwh, kw }, peakCut: { pct, kw: 0, months: 12 } });
  const pick = DS.kneePick([R('a', 150, 30, 0.05), R('b', 600, 200, 0.2), R('c', 400, 130, 0.18), R('d', 1200, 240, 0.21)]);
  assert.equal(pick.config.id, 'c');
  // only systems the site can discharge into; if none fits, the smallest
  assert.equal(DS.kneePick([R('a', 150, 30, 0.05), R('b', 600, 200, 0.2), R('c', 400, 130, 0.18)], { maxKw: 150 }).config.id, 'c');
  assert.equal(DS.kneePick([R('b', 600, 200, 0.97), R('c', 400, 130, 0.9), R('a', 150, 30, 0.6)], { maxKw: 20 }).config.id, 'a');
});

test('engine: placeholder costs are ignored (cost-free pick and score); real costs rank by NPV as before', () => {
  const placeholder = { ...fixtureData, products: fixtureData.products.map((p) => ({ ...p, cost_is_placeholder: true })) };
  const a = analyzeSite(baseSite, placeholder);
  assert.equal(a.costsKnown, false);
  assert.equal(a.recommended, DS.kneePick(a.results.filter((r) => r.constraints.status !== 'critical'), { maxKw: a.limits.usefulKwCeiling ?? baseSite.peak_kw }));
  assert.match(a.score.basis, /kWh-yr/);
  for (const r of a.results) {
    assert.ok(r.demand && r.demand.rows.length === 12, 'every configuration carries its monthly demand view');
    assert.ok(r.peakCut.pct >= 0 && r.peakCut.pct <= 1);
  }
  const b = analyzeSite(baseSite, fixtureData);
  assert.equal(b.costsKnown, true);
  const best = b.results.filter((r) => r.constraints.status !== 'critical' && r.finance.base.npv != null).reduce((x, r) => (r.finance.base.npv > x.finance.base.npv ? r : x));
  assert.equal(b.recommended, best);
});

test('engine: bill mode values demand from the bills for every configuration', () => {
  const months = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => [m, { usd: 2000, kw: baseSite.peak_kw }]));
  const a = analyzeSite({ ...baseSite, bills: { use: true, months } }, fixtureData);
  const rate = 2000 / baseSite.peak_kw;
  for (const r of a.results) {
    assert.equal(r.demand.mode, 'bills');
    const sum = r.demand.rows.reduce((n, x) => n + (x.savings || 0), 0);
    near(r.demand.total, sum, 1e-6);
    for (const x of r.demand.rows) near(x.savings, Math.max(0, baseSite.peak_kw - x.after) * rate, 1e-6);
  }
  const off = analyzeSite({ ...baseSite, bills: { use: false, months } }, fixtureData);
  assert.equal(off.results[0].demand.mode, 'tariff');
});
