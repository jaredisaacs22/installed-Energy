// Demand-reduction savings, month by month, with no costs involved: how far the battery lowers each month's
// billed demand and what that is worth at the site's demand charges.
//
// The dollars come from one of two places:
//   • The customer's bills (site.bills). This is the Site Analysis Workbench's bill model (dispatchSavings),
//     ported: billed before = the bill's billed kW (the metered peak when left blank); billed after = the
//     peak the battery actually holds, never below the ratchet floor (ratchet % × the highest held peak of
//     the year); savings = (before − after) × the month's $/kW, where $/kW = demand charges ÷ billed kW.
//   • The selected tariff: the Atlas valuation (engine/value.js demandChargeStreams).
//
// The kW come from engine/hold.js: each month's sustainable hold (the lowest peak the battery holds on every
// day of that month), or a target typed on the Demand savings tab. Below the hold the battery cannot keep the
// target on every day, so the month is billed at the real shaved peak, not the wished-for target.
//
// The cost-free system pick is the workbench's "knee": the smallest system (least installed kWh) that gets
// within 3 points of the deepest average monthly peak cut any candidate achieves.

import * as H from './hold.js';
import { simBatteryOf } from './value.js';

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const KNEE_POINTS = 0.03;

const numOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * The bill entries stored on a site, cleaned: { use, months: { m: { usd, kw } }, flatRate ($/kW) | null,
 * ratchetPct (0-1) | null }. flatRate prices every month that has no demand-charge amount of its own.
 */
export function billsOf(site) {
  const b = site?.bills || {};
  const months = {};
  for (const m of ALL) {
    const e = b.months?.[m];
    if (!e) continue;
    const usd = numOrNull(e.usd);
    const kw = numOrNull(e.kw);
    if ((usd != null && usd >= 0) || (kw != null && kw > 0)) months[m] = { usd: usd != null && usd >= 0 ? usd : null, kw: kw != null && kw > 0 ? kw : null };
  }
  const r = numOrNull(b.ratchet_pct);
  const flat = numOrNull(b.rate_usd_per_kw);
  return { use: !!b.use, months, flatRate: flat != null && flat > 0 ? flat : null, ratchetPct: r == null ? null : Math.max(0, Math.min(1, r / 100)) };
}

/** Months with a demand-charge amount entered. */
export function billedMonths(bills) {
  return ALL.filter((m) => bills.months[m]?.usd != null);
}

/** True when demand is valued from the site's bills: bills chosen and a $/kW rate or some month's charges entered. */
export function usesBills(site) {
  const b = billsOf(site);
  return b.use && (b.flatRate != null || billedMonths(b).length > 0);
}

/** The ratchet the selected rate carries (fraction), else 0. Used when the bill entry leaves it blank. */
export function tariffRatchet(tariff) {
  const p = tariff?.ratchet?.pct;
  return typeof p === 'number' && p > 0 ? Math.min(1, p) : 0;
}

// ---- holds, cached per interval object (the all-days search is the expensive part) ----
const memos = new WeakMap();
const designMemo = new Map();
const unitSig = (u) => [u.kw, u.chargeKw, u.usableKwh, u.effC, u.effD, u.reserve].map((x) => Math.round((+x || 0) * 1e6) / 1e6).join('/');

/**
 * Sustainable holds for a hold unit, cached. monthPeaks scales the design day for months without interval data.
 * Shared by the engine (every configuration) and the Demand savings tab (the selected one), so each search runs once.
 */
export function cachedHolds(interval, profile, u, opt, monthPeaks = null) {
  let store = designMemo;
  if (interval) {
    store = memos.get(interval);
    if (!store) memos.set(interval, (store = new Map()));
  }
  const key = [unitSig(u), opt.carry ? 1 : 0, JSON.stringify(opt.sched || null), JSON.stringify(monthPeaks || null), interval ? '' : `${profile.dtHours}:${profile.kw.join(',')}`].join('|');
  if (!store.has(key)) {
    if (store.size > 200) store.clear();
    store.set(key, H.monthlyHolds(interval, profile, u, opt, monthPeaks));
  }
  return store.get(key);
}

/** The workbench's effective battery for a configuration, with the site's reserve held back. */
export function holdUnitFor(a, config) {
  return H.holdUnitOf(simBatteryOf(config, a.assumptions), H.dispatchOptionsOf(a.site).reserve);
}

/** Billed kW per month, to scale the design day by in bill mode. */
function billPeaks(bills) {
  const out = {};
  for (const m of ALL) if (bills.months[m]?.kw > 0) out[m] = bills.months[m].kw;
  return Object.keys(out).length ? out : null;
}

/** Billed kW to scale the design day by: only when demand is valued from the bills. */
export function monthPeaksFor(site) {
  return usesBills(site) ? billPeaks(billsOf(site)) : null;
}

/** Holds for one configuration on this site (bill-scaled design days in bill mode). */
export function holdsFor(a, config, interval) {
  return cachedHolds(interval, a.profile, holdUnitFor(a, config), H.dispatchOptionsOf(a.site), monthPeaksFor(a.site));
}

/** Average monthly peak cut at the sustainable holds: { pct (0-1), kw, months }. */
export function depthOf(holds) {
  let pct = 0;
  let kw = 0;
  let n = 0;
  for (const m of ALL) {
    const x = holds[m];
    if (!x || x.achievable == null || !(x.peak > 0)) continue;
    const cut = Math.max(0, x.peak - x.achievable);
    pct += cut / x.peak;
    kw += cut;
    n++;
  }
  return n ? { pct: pct / n, kw: kw / n, months: n } : { pct: 0, kw: 0, months: 0 };
}

/**
 * The cost-free pick: the smallest system (least installed kWh, then kW) within 3 points of the deepest
 * average monthly peak cut. results carry `peakCut` (depthOf). Only systems whose kW the site can use are
 * considered (maxKw: the useful discharge ceiling, about the site's load): a bigger battery "cuts" the peak by
 * running the building, not by shaving it. When every system is bigger than that, the smallest one is picked.
 */
export function kneePick(results, { maxKw = Infinity } = {}) {
  const fits = results.filter((r) => r.peakCut && r.peakCut.months > 0 && r.config.kw <= maxKw + 1e-9);
  if (!fits.length) {
    const any = results.filter((r) => r.peakCut && r.peakCut.months > 0);
    return any.length ? any.reduce((k, r) => (r.config.kw < k.config.kw || (r.config.kw === k.config.kw && r.config.kwh < k.config.kwh) ? r : k)) : results[0] || null;
  }
  const cands = fits;
  const best = Math.max(...cands.map((r) => r.peakCut.pct));
  return cands.filter((r) => r.peakCut.pct >= best - KNEE_POINTS).reduce((k, r) => (r.config.kwh < k.config.kwh || (r.config.kwh === k.config.kwh && r.config.kw < k.config.kw) ? r : k));
}

/**
 * Peak actually held in month m at target t (the workbench's achievedAt): at or above the sustainable hold the
 * battery holds t exactly; below it, the highest shaved peak across every day of the month (interval data) or
 * on the design day.
 */
export function heldAt(interval, m, t, hold, u, opt) {
  if (t >= hold.achievable - 0.05) return t;
  if (hold.basis === 'interval') {
    const sc = H.monthSustainCheck(H.daysOfMonth(interval, m), t, u, interval.dtHours, opt.sched, opt.carry);
    return sc ? sc.worstAfter : t;
  }
  return hold.profile ? Math.round(H.dispatchAchieved(hold.profile, t, u, hold.profile.length ? 24 / hold.profile.length : 1, opt.sched) * 10) / 10 : t;
}

/**
 * The bill model for one system. holds from holdsFor/cachedHolds; targets = { m: kW } overrides (Demand savings tab);
 * held(m, t, hold) = the peak held at t (heldAt). Months without a demand-charge amount use the flat $/kW when
 * one is given, else the average $/kW of the months entered (flagged `estimated`).
 * Returns { rows, total, floor, maxHeld, entered, estimated }.
 */
export function billSavings({ holds, bills, ratchetPct = 0, targets = {}, held = (m, t) => t }) {
  const info = {};
  let maxHeld = 0;
  for (const m of ALL) {
    const x = holds[m];
    if (!x || x.achievable == null) continue;
    const ov = targets[m];
    let t = ov != null && ov !== '' && Number.isFinite(+ov) ? +ov : x.achievable;
    t = Math.max(0, Math.min(x.peak, t));
    const ach = held(m, t, x);
    info[m] = { peak: x.peak, achievable: x.achievable, target: t, held: ach, override: ov != null && ov !== '' && Number.isFinite(+ov) };
    if (ach > maxHeld) maxHeld = ach;
  }
  const floor = ratchetPct * maxHeld;
  const rateOf = (m) => {
    const b = bills.months[m];
    if (b?.usd == null) return bills.flatRate ?? null;
    const kw = b.kw ?? info[m]?.peak;
    return kw > 0 ? b.usd / kw : null;
  };
  const entered = ALL.filter((m) => info[m] && rateOf(m) != null);
  const avgRate = entered.length ? entered.reduce((n, m) => n + rateOf(m), 0) / entered.length : null;
  const rows = [];
  let total = 0;
  let estimated = 0;
  for (const m of ALL) {
    const I = info[m];
    if (!I) {
      rows.push({ m, missing: true });
      continue;
    }
    const b = bills.months[m];
    const own = rateOf(m);
    const rate = own ?? avgRate;
    const before = b?.kw ?? I.peak;
    const after = Math.max(I.held, floor);
    const reduction = Math.max(0, before - after);
    const savings = rate != null ? reduction * rate : null;
    if (savings != null) total += savings;
    if (own == null && rate != null) estimated++;
    rows.push({ m, ...I, before, beforeFromBill: b?.kw != null, after, floorBinds: floor > I.held + 1e-9, reduction, rate, estimated: own == null && rate != null, flat: b?.usd == null && bills.flatRate != null, usd: b?.usd ?? null, savings });
  }
  return { rows, total, floor, maxHeld, entered: entered.length, estimated };
}

/** The tariff valuation as monthly rows (the Atlas demand-charge dollars; kW of the main charge). */
export function tariffSavings(r, holds) {
  const md = r.monthDetail || {};
  const primary = (dm) => dm.comps.find((c) => !c.window) || dm.comps.reduce((b, c) => (c.usd > b.usd ? c : b), dm.comps[0]);
  const rows = [];
  let total = 0;
  for (const m of ALL) {
    const x = holds[m];
    const d = md[m];
    if (!x && !d) {
      rows.push({ m, missing: true });
      continue;
    }
    const c = d?.comps?.length ? primary(d) : null;
    const savings = d ? d.usd : 0;
    total += savings;
    rows.push({
      m,
      peak: x?.peak ?? d?.peak,
      achievable: x?.achievable ?? null,
      held: c ? c.target : x?.achievable,
      reduction: c ? c.reduction : 0,
      rate: c ? d.comps.reduce((n, k) => n + (k.reduction > 0 ? k.rate : 0), 0) : null,
      savings,
      noCharge: !d,
      eventLimited: !!d?.eventLimited,
    });
  }
  return { rows, total };
}

/**
 * Demand savings for one system on this site: { mode: 'bills' | 'tariff', rows, total, holds, depth, ... }.
 * targets (optional) are the Demand savings tab's per-month overrides; they move the dollars in bill mode only.
 * forceBills lays out the bill rows even before any charges are entered (the entry table).
 */
export function demandModel(a, r, interval, { targets = null, forceBills = false } = {}) {
  const holds = holdsFor(a, r.config, interval);
  const depth = depthOf(holds);
  if (forceBills || usesBills(a.site)) {
    const bills = billsOf(a.site);
    const ratchetPct = bills.ratchetPct ?? tariffRatchet(a.tariff);
    const opt = H.dispatchOptionsOf(a.site);
    const u = holdUnitFor(a, r.config);
    const res = billSavings({ holds, bills, ratchetPct, targets: targets || {}, held: (m, t, x) => heldAt(interval, m, t, x, u, opt) });
    return { mode: 'bills', ratchetPct, ratchetFromTariff: bills.ratchetPct == null && ratchetPct > 0, holds, depth, ...res };
  }
  return { mode: 'tariff', holds, depth, ...tariffSavings(r, holds) };
}
