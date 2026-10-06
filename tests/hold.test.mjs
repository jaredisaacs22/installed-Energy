// The workbench's dispatch core as ported to engine/hold.js. The expected figures are what the original
// workbench file itself reports for the same synthetic site and systems (generated in a real browser from
// tests/workbench-fixture.mjs with peak 300 kW, seed 7), so a change here that moves a number is a change
// from the workbench's own answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeRaw, buildInterval } from '../assets/js/workbench.js';
import * as H from '../assets/js/engine/hold.js';
import { makeWorkbenchSite } from './workbench-fixture.mjs';
import { analyzeSite } from '../assets/js/engine/index.js';
import { demandChargeStreams } from '../assets/js/engine/value.js';
import { buildConfig } from '../assets/js/engine/configs.js';
import { designDayProfile } from '../assets/js/engine/loadshape.js';
import { inputRows } from '../assets/js/export.js';
import { data as fixtureData, products as fixtureProducts, baseSite, global as fixtureGlobal } from './fixture.mjs';

const site = makeWorkbenchSite({ peakKw: 300, seed: 7 });
const iv = buildInterval(decodeRaw(site.raw));
const unit = (spec, reserve = 0) => ({ ...spec, effC: 0.94, effD: 0.94, reserve });
const S30 = { kw: 30, chargeKw: 30, usableKwh: 130.2 };
const S65 = { kw: 65, chargeKw: 40, usableKwh: 173.6 };
const S200 = { kw: 200, chargeKw: 200, usableKwh: 520 };
const holdsOf = (u, opts) => Array.from({ length: 12 }, (_, i) => H.monthlyHolds(iv, null, u, opts)[i + 1].achievable);
const sched = (over = {}) => ({ enabled: true, disStart: 14, disEnd: 21, chgMode: 'auto', chgStart: 21, chgEnd: 8, months: 'all', days: 'all', ...over });

test('hold: sustainable holds match the workbench (default dispatch, every day starts full)', () => {
  assert.deepEqual(holdsOf(unit(S30), {}), [209, 209, 232.5, 235, 237, 247.5, 247.5, 248, 270, 209, 236, 235]);
});

test('hold: a reserve holds back stored energy and costs peak reduction (workbench figures)', () => {
  assert.deepEqual(holdsOf(unit(S65, 0.2), {}), [208, 208.5, 212.5, 214, 213.5, 233, 232, 232.5, 242, 208, 213, 213.5]);
  const none = holdsOf(unit(S65), {});
  const some = holdsOf(unit(S65, 0.2), {});
  assert.ok(some.every((v, i) => v >= none[i] - 1e-9), 'a reserve never makes a month easier to hold');
  assert.ok(some.some((v, i) => v > none[i] + 0.05), 'and it costs something where energy limits the cut');
});

test('hold: carrying charge across days gives the realistic, shallower holds (workbench figures)', () => {
  assert.deepEqual(holdsOf(unit(S200), { carry: true }), [180.5, 181, 183, 184, 184, 192.5, 192.5, 192.5, 196, 180.5, 183, 184]);
  const fresh = holdsOf(unit(S200), {});
  const carry = holdsOf(unit(S200), { carry: true });
  assert.ok(carry.every((v, i) => v >= fresh[i] - 1e-9), 'carrying SOC is never easier than a full recharge every day');
});

test('hold: a discharge window limits what can be shaved (workbench figures)', () => {
  assert.deepEqual(holdsOf(unit(S65), { sched: sched() }), [232.5, 233, 262.5, 265, 266.5, 269.5, 267.5, 269, 294, 233, 263.5, 257]);
});

test('hold: summer-only weekday schedule with a charge window and a reserve (workbench figures)', () => {
  const sc = sched({ disStart: 13, disEnd: 19, chgMode: 'window', months: 'summer', days: 'weekdays' });
  assert.deepEqual(holdsOf(unit(S65, 0.1), { sched: sc }), [206.5, 207, 211, 212, 211.5, 249, 249, 249, 249.5, 206.5, 211, 212]);
});

test('hold: schedule resolution by month and weekday, including overnight windows', () => {
  const sc = sched({ months: 'summer', days: 'weekdays' });
  assert.equal(H.schedForDate(sc, '2025-7-16'), sc, 'a July Wednesday is governed');
  assert.equal(H.schedForDate(sc, '2025-7-19'), null, 'a Saturday is not');
  assert.equal(H.schedForDate(sc, '2025-1-15'), null, 'January is not');
  assert.equal(H.schedForDate(null, '2025-7-16'), null);
  assert.ok(H.schedInWin(23, 22, 6) && H.schedInWin(3, 22, 6) && !H.schedInWin(12, 22, 6));
  assert.equal(H.winLenHrs(22, 6), 8);
  assert.equal(H.winLenHrs(5, 5), 0);
});

test('hold: month check reports the highest shaved peak and the binding day', () => {
  const days = H.daysOfMonth(iv, 7);
  const u = unit(S30);
  const hold = H.monthlyHolds(iv, null, u, {})[7].achievable;
  const ok = H.monthSustainCheck(days, hold, u, iv.dtHours, null, false);
  assert.equal(ok.holdsAll, true);
  assert.equal(ok.days, days.length);
  const deeper = H.monthSustainCheck(days, hold - 20, u, iv.dtHours, null, false);
  assert.equal(deeper.holdsAll, false, 'asking for more than the battery can hold is flagged');
  assert.ok(deeper.worstAfter > hold - 20);
  assert.match(deeper.bindingDate, /^2025-7-\d+$/);
});

test('hold: dispatch trace honours the reserve floor and the discharge window', () => {
  const days = H.daysOfMonth(iv, 7);
  const u = unit(S30, 0.5);
  const day = days.reduce((b, d) => (Math.max(...d.map((q) => q.kW)) > Math.max(...b.map((q) => q.kW)) ? d : b), days[0]);
  const r = H.dispatchProfileFrom(day, 100, u, iv.dtHours, null, null);
  assert.ok(Math.abs(r.floor - 65.1) < 1e-9);
  assert.ok(r.minSOC >= r.floor - 1e-9, 'never discharged below the reserve');
  const w = H.dispatchProfileFrom(day, 100, unit(S30), iv.dtHours, sched({ disStart: 0, disEnd: 1 }), null);
  assert.equal(w.eDis, 0, 'no discharge outside the window (the peak is mid-afternoon)');
  assert.equal(w.held, false);
});

test('hold: maximize-discharge-on-lighter-days never goes past the monthly target, and is off while carrying', () => {
  const days = H.daysOfMonth(iv, 7);
  const u = unit(S65);
  const target = H.monthlyHolds(iv, null, u, {})[7].achievable;
  const light = days.reduce((b, d) => (Math.max(...d.map((q) => q.kW)) < Math.max(...b.map((q) => q.kW)) ? d : b), days[0]);
  assert.equal(H.maxDischargeCapFor(light, u, iv.dtHours, null, target, {}), target, 'off by default');
  const on = H.maxDischargeCapFor(light, u, iv.dtHours, null, target, { maxDaily: true });
  assert.ok(on <= target + 1e-9 && on < target - 0.05, 'a light day can discharge deeper than the target');
  assert.equal(H.maxDischargeCapFor(light, u, iv.dtHours, null, target, { maxDaily: true, carry: true }), target, 'ignored while carry is on');
});

test('hold: no interval data falls back to the design day as a single worst-day estimate', () => {
  const profile = { kw: Array.from({ length: 24 }, (_, h) => 100 + (h >= 12 && h < 18 ? 60 : 0)), dtHours: 1 };
  const holds = H.monthlyHolds(null, profile, unit(S65), {});
  assert.equal(Object.keys(holds).length, 12);
  assert.equal(holds[7].basis, 'design');
  assert.ok(holds[7].achievable < 160 && holds[7].achievable >= 95);
});

test('hold: reserve is clamped to 0–90% and adapters carry the battery spec across', () => {
  assert.equal(H.reserveFracOf(-1), 0);
  assert.equal(H.reserveFracOf(0.3), 0.3);
  assert.equal(H.reserveFracOf(2), 0.9);
  assert.equal(H.reserveFracOf('abc'), 0);
  const u = H.holdUnitOf({ kw: 65, chargeKw: 40, storedKwh: 173.6, effCharge: 0.94, effDischarge: 0.94 }, 0.25);
  assert.deepEqual(u, { kw: 65, chargeKw: 40, usableKwh: 173.6, effC: 0.94, effD: 0.94, reserve: 0.25 });
});

// ---- how the Savings tab settings reach the engine ----

test('dispatch settings: read from the site, carry wins over maximize, reserve is a fraction', () => {
  assert.deepEqual(H.dispatchOptionsOf({}), { reserve: 0, carry: false, maxDaily: false, sched: null, targets: {} });
  const o = H.dispatchOptionsOf({ dispatch: { reserve_pct: 25, carry: true, max_daily: true, sched: { enabled: true, disStart: 14, disEnd: 21 }, month_targets: { 7: 290 } } });
  assert.equal(o.reserve, 0.25);
  assert.equal(o.carry, true);
  assert.equal(o.maxDaily, false, 'carry turns maximize off');
  assert.equal(o.sched.disStart, 14);
  assert.deepEqual(o.targets, { 7: 290 });
  assert.equal(H.dispatchOptionsOf({ dispatch: { sched: { enabled: false, disStart: 1, disEnd: 2 } } }).sched, null, 'a disabled schedule is no schedule');
  assert.equal(H.dispatchOptionsOf({ dispatch: { reserve_pct: 500 } }).reserve, 0.9);
});

test('custom system: a hand-built mix is evaluated alongside the standard configurations', () => {
  const site = { ...baseSite, custom_system: [{ productId: 'B30-150', count: 1 }, { productId: 'B65-200', count: 2 }] };
  const a = analyzeSite(site, fixtureData);
  const mix = a.results.find((r) => r.config.id === '1xB30-150+2xB65-200');
  assert.ok(mix, 'the mix is in the results');
  assert.equal(mix.config.kw, 160);
  assert.equal(a.results.length, analyzeSite(baseSite, fixtureData).results.length + 1);
  // the same system chosen as a plain candidate is not added twice
  const dup = analyzeSite({ ...baseSite, custom_system: [{ productId: 'B30-150', count: 2 }] }, fixtureData);
  assert.equal(dup.results.filter((r) => r.config.id === '2xB30-150').length, 1);
  // exports keep a custom system readable
  const row = inputRows(a).find((r) => r.key === 'custom_system');
  assert.match(row.value, /"productId":"B65-200"/);
});

test('reserve capacity: holds energy back from demand-charge shaving, and costs nothing where kW limits the cut', () => {
  const tariff = { id: 't', demand_charges: [{ label: 'NCP', basis: 'ncp_monthly', rate_usd_per_kw_month: 15, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }] };
  const A2 = Object.fromEntries(fixtureGlobal.assumptions.map((x) => [x.key, x.value]));
  const profile = designDayProfile({ peakKw: iv.peak_kw, annualKwh: iv.annual_kwh, buildingType: 'retail' });
  const usd = (cfg, reserve) => demandChargeStreams({ ...baseSite, peak_kw: iv.peak_kw, annual_kwh: iv.annual_kwh, energy_price: 0.2, dispatch: { reserve_pct: reserve } }, cfg, tariff, A2, profile, [], iv).streams[0].annual_usd;
  const small = buildConfig([{ productId: 'B65-200', count: 1 }], fixtureProducts);
  assert.ok(usd(small, 50) < usd(small, 0) - 1, 'half the energy held back lowers the demand savings of an energy-limited system');
  assert.equal(usd(small, 0), usd(small, undefined), 'no reserve is the default');
  // a very large system never runs short of energy, so a modest reserve is free
  const big = buildConfig([{ productId: 'B200-600', count: 2 }], fixtureProducts);
  assert.ok(Math.abs(usd(big, 10) - usd(big, 0)) < 1, 'kW-limited: the reserve costs nothing');
});
