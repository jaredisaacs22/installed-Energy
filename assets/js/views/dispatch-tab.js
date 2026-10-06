// Sizing & dispatch section of the Savings tab: the Site Analysis Workbench's Sizing tab, built in.
// A custom system builder, reserve capacity, a fixed dispatch schedule, charge carried across days and deeper
// discharge on lighter days, then the daily dispatch by month (any day of the month, single day or monthly
// totals, with an audit table and CSV downloads) and the per-month peak targets, which can be overridden.
//
// All of the kW work is the workbench's own dispatch core (engine/hold.js), so the sustainable holds and
// dispatch traces here match the workbench's. Demand-charge dollars still come from the Atlas valuation; only
// the reserve feeds them (see each card's note).
import { h, num, usd } from '../ui.js';
import { download } from '../export.js';
import { dispatchDayChart, socChart, hhmm } from '../dispatch-chart.js';
import { buildConfig } from '../engine/configs.js';
import { simBatteryOf } from '../engine/value.js';
import * as H from '../engine/hold.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---- cached hold searches (they are the expensive part), keyed per interval object ----
const memos = new WeakMap();
const designMemo = new Map();
function memo(iv, key, fn) {
  let store = designMemo;
  if (iv) {
    store = memos.get(iv);
    if (!store) memos.set(iv, (store = new Map()));
  }
  if (!store.has(key)) {
    if (store.size > 120) store.clear();
    store.set(key, fn());
  }
  return store.get(key);
}
const unitSig = (u) => [u.kw, u.chargeKw, u.usableKwh, u.effC, u.effD, u.reserve].map((x) => Math.round((+x || 0) * 1e6) / 1e6).join('/');

function holdsFor(ctx, u, o) {
  const key = ['h', unitSig(u), o.carry ? 1 : 0, JSON.stringify(o.sched || null), ctx.iv ? '' : ctx.a.profile.kw.join(',')].join('|');
  return memo(ctx.iv, key, () => H.monthlyHolds(ctx.iv, ctx.a.profile, u, o));
}

/** Everything the cards share, computed once per render. */
function derive(ctx) {
  const { site, a, r, iv } = ctx;
  const opt = H.dispatchOptionsOf(site);
  const battery = simBatteryOf(r.config, a.assumptions);
  const u = H.holdUnitOf(battery, opt.reserve);
  const holds = holdsFor(ctx, u, opt);
  const dt = iv ? iv.dtHours : a.profile.dtHours;
  const months = Array.from({ length: 12 }, (_, i) => i + 1).filter((m) => holds[m] && holds[m].achievable != null);
  const targetOf = (m) => {
    const x = holds[m];
    const ov = opt.targets[m];
    return Math.max(0, Math.min(x.peak, ov != null && Number.isFinite(+ov) ? +ov : x.achievable));
  };
  let defaultMonth = months[0];
  for (const m of months) if (holds[m].peak > holds[defaultMonth].peak) defaultMonth = m;
  return { opt, battery, u, holds, dt, months, targetOf, defaultMonth };
}

const avgCut = (holds, months) => {
  let s = 0;
  let n = 0;
  for (const m of months) {
    const x = holds[m];
    if (x.peak > 0) {
      s += Math.max(0, (x.peak - x.achievable) / x.peak);
      n++;
    }
  }
  return n ? s / n : null;
};

const csvNum = (n, d = 0) => (n == null || Number.isNaN(n) ? '' : (Math.round(n * 10 ** d) / 10 ** d).toFixed(d));
const csvTxt = (s) => (/[",\n]/.test(String(s ?? '')) ? `"${String(s ?? '').replace(/"/g, '""')}"` : String(s ?? ''));
const pad2 = (x) => String(x).padStart(2, '0');
const normKey = (k) => {
  const p = String(k ?? '').split('-');
  return p.length === 3 ? `${+p[0]}-${+p[1]}-${+p[2]}` : String(k);
};
const isoKey = (k) => {
  const p = normKey(k).split('-');
  return `${p[0]}-${pad2(p[1])}-${pad2(p[2])}`;
};

// ============================================================================================
// Public entry
// ============================================================================================

/**
 * ctx = { site, a, r, iv, products, ui, setDispatch(patch), setCustomSystem(items|null), rerender(), planView(month) }
 *   ui: { month, day, view: 'day'|'month', basis: 'workbench'|'plan' }  (mutable, kept by the screener)
 * Returns { settings: [cards], dispatch: [cards], targets: [card], cut } so the screener can place its own
 * cards (banner, streams) between them.
 */
export function dispatchSection(ctx) {
  const D = derive(ctx);
  return {
    settings: [systemCard(ctx, D), reserveCard(ctx, D), scheduleCard(ctx, D), carryCard(ctx, D), maxDailyCard(ctx, D)],
    dispatch: dispatchCards(ctx, D),
    targets: targetsCard(ctx, D),
    cut: avgCut(D.holds, D.months),
    D,
  };
}

// ============================================================================================
// Option cards
// ============================================================================================

function opt(title, { on, status, children }) {
  return h('details', { class: `card opt-card${on ? ' on' : ''}`, open: on ? true : null },
    h('summary', {}, h('span', { class: 'opt-title' }, title), h('span', { class: `badge ${on ? 'ok' : ''}` }, status)),
    h('div', { class: 'opt-body' }, ...children.filter(Boolean)),
  );
}

function systemCard(ctx, D) {
  const items = ctx.site.custom_system || [];
  const counts = Object.fromEntries(items.map((it) => [it.productId, it.count]));
  const cfg = items.length ? buildConfig(items, ctx.products) : null;
  const bump = (id, delta) => {
    const next = ctx.products.map((p) => ({ productId: p.id, count: Math.max(0, (counts[p.id] || 0) + (p.id === id ? delta : 0)) })).filter((x) => x.count > 0);
    ctx.setCustomSystem(next.length ? next : null);
  };
  const rows = ctx.products.map((p) => {
    const n = counts[p.id] || 0;
    return h('tr', { class: n ? 'in-mix' : '' },
      h('td', {}, p.label),
      h('td', { class: 'num' }, num(p.kw)),
      h('td', { class: 'num' }, num(p.usable_kwh ?? p.kwh)),
      h('td', { class: 'num' }, num(p.charge_kw ?? p.kw)),
      h('td', { class: 'qty' },
        h('button', { class: 'btn small', type: 'button', disabled: n ? null : true, 'aria-label': `Remove one ${p.label}`, onclick: () => bump(p.id, -1) }, '−'),
        h('b', {}, String(n)),
        h('button', { class: 'btn small primary', type: 'button', 'aria-label': `Add one ${p.label}`, onclick: () => bump(p.id, +1) }, '+')),
    );
  });
  return opt('Build a custom system', {
    on: !!cfg,
    status: cfg ? `Active: ${num(cfg.kw)} kW / ${num(cfg.usableKwh ?? cfg.kwh)} kWh` : 'off — comparing the standard configurations',
    children: [
      h('p', { class: 'small ink2' }, 'Mix different models into one system with + and −. It is added to the configuration list and selected, and everything on this tab (per-month targets, dispatch, charts) recalculates on the combined system. Leave every count at 0 to go back to the standard configurations.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Model'), h('th', { class: 'num' }, 'kW'), h('th', { class: 'num' }, 'kWh usable'), h('th', { class: 'num' }, 'Charge kW'), h('th', {}, 'Qty'))),
        h('tbody', {}, ...rows))),
      cfg ? h('div', { class: 'opt-foot' }, h('p', { class: 'small' }, h('b', {}, 'Your system: '), cfg.label), h('button', { class: 'btn small', type: 'button', onclick: () => ctx.setCustomSystem(null) }, 'Clear custom system')) : null,
    ],
  });
}

function reserveCard(ctx, D) {
  const { opt: o, u } = D;
  const r = o.reserve;
  const usable = u.usableKwh;
  const floor = H.reserveFloorKwh(u);
  const input = h('input', { type: 'number', min: 0, max: 90, step: 1, value: r ? Math.round(r * 1000) / 10 : 0, 'aria-label': 'Reserve capacity percent', onchange: (e) => ctx.setDispatch({ reserve_pct: Math.max(0, Math.min(90, +e.target.value || 0)) }) });
  const kids = [
    h('p', { class: 'small ink2' }, 'Keep part of the battery always available for an emergency. The reserve is never discharged for peak shaving, so it only costs peak reduction where energy (kWh), not power (kW), limits the cut. The battery still charges to full.'),
    h('div', { class: 'dgrid' }, h('div', { class: 'field' }, h('label', {}, 'Hold back this % of usable kWh'), input, h('div', { class: 'hint' }, `0–90% · of the ${num(usable)} kWh usable, not the nameplate`))),
  ];
  if (!(r > 0)) kids.push(h('p', { class: 'small muted' }, `Off — all ${num(usable)} kWh is available for peak shaving. (For example, 10% would hold back ${num(usable * 0.1)} kWh.)`));
  else {
    kids.push(h('p', { class: 'small' }, h('b', {}, `${num(floor)} kWh`), ` is held back (stored energy; about ${num(floor * (u.effD || 1))} kWh deliverable). `, h('b', {}, `${num(Math.max(0, usable - floor))} kWh`), ` of the ${num(usable)} kWh usable is available for peak shaving.`));
    const base = holdsFor(ctx, { ...u, reserve: 0 }, o);
    const rows = [];
    let sumB = 0;
    let sumC = 0;
    let n = 0;
    let changed = 0;
    for (const m of D.months) {
      const b = base[m];
      const c = D.holds[m];
      if (!b || !(b.peak > 0) || b.achievable == null) continue;
      const d = c.achievable - b.achievable;
      sumB += Math.max(0, (b.peak - b.achievable) / b.peak);
      sumC += Math.max(0, (c.peak - c.achievable) / c.peak);
      n++;
      if (d > 0.05) changed++;
      rows.push({ m, peak: b.peak, base: b.achievable, cur: c.achievable, d });
    }
    if (n && !changed) kids.push(h('div', { class: 'check-ok' }, '✓ ', h('b', {}, 'No cost on this site. '), `In all ${n} months the cut is limited by power (kW), not energy (kWh), so holding this reserve back changes no month’s sustainable peak.`));
    else if (n) {
      kids.push(h('div', { class: 'check-warn' }, '⚠ ', h('b', {}, `Costs peak reduction in ${changed} of ${n} months. `), `The average monthly peak cut falls from ${((sumB / n) * 100).toFixed(1)}% to ${((sumC / n) * 100).toFixed(1)}%.`, n - changed ? ` In the other ${n - changed} the cut is limited by power, so the reserve is free.` : ''));
      kids.push(h('details', {}, h('summary', { class: 'small' }, 'Month by month — sustainable peak with and without the reserve'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, ['Month', 'Peak kW', 'No reserve', 'With reserve', 'Cost'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
          h('tbody', {}, rows.map((x) => h('tr', { class: x.d > 0.05 ? 'hi' : '' }, h('td', {}, MON[x.m - 1]), h('td', { class: 'num' }, num(x.peak, 1)), h('td', { class: 'num' }, num(x.base, 1)), h('td', { class: 'num' }, h('b', {}, num(x.cur, 1))), h('td', { class: 'num' }, x.d > 0.05 ? `+${num(x.d, 1)} kW` : '—')))))),
        h('p', { class: 'small muted' }, '“Cost” is how much shallower the month’s sustainable peak gets (higher kW = less reduction). Same system, data, schedule and carry setting; only the reserve differs.')));
    }
    kids.push(h('p', { class: 'small muted' }, 'The reserve also applies to the demand-charge dollars on this tab; other value streams (DR events, arbitrage) are not reserve-aware.'));
  }
  return opt('Reserve capacity (optional)', { on: r > 0, status: r > 0 ? `${num(floor)} kWh held back` : 'none held back', children: kids });
}

/** Hours of the day at which the battery could need to discharge: any load within the battery's kW of a monthly peak. */
function scheduleSuggestion(ctx, D) {
  let lo = null;
  let hi = null;
  const upd = (hr) => {
    if (lo == null || hr < lo) lo = hr;
    if (hi == null || hr > hi) hi = hr;
  };
  for (const m of D.months) {
    const days = ctx.iv ? H.daysOfMonth(ctx.iv, m) : null;
    const peak = D.holds[m].peak;
    if (days) days.forEach((d) => d.forEach((q) => { if (q.kW > peak - D.u.kw) upd(q.h); }));
    else ctx.a.profile.kw.forEach((v, i) => { if (v > peak - D.u.kw) upd(i * ctx.a.profile.dtHours); });
  }
  return lo == null ? null : { s: Math.max(0, Math.floor(lo)), e: Math.min(24, Math.floor(hi) + 1), min: lo, max: hi };
}

function scheduleCard(ctx, D) {
  const raw = ctx.site.dispatch?.sched || null;
  const on = !!(raw && raw.enabled);
  const sug = scheduleSuggestion(ctx, D);
  const sc = D.opt.sched;
  const setSched = (patch) => ctx.setDispatch({ sched: { ...(raw || defaultSched(sug)), ...patch } });
  const toggle = h('label', { class: 'small', style: { cursor: 'pointer' } }, h('input', { type: 'checkbox', checked: on ? true : null, onchange: (e) => (e.target.checked ? setSched({ enabled: true }) : ctx.setDispatch({ sched: raw ? { ...raw, enabled: false } : null })) }), ' Restrict to a fixed schedule');
  const kids = [toggle];
  if (!on) {
    kids.push(h('p', { class: 'small ink2' }, h('b', {}, 'Automatic'), ' — the battery responds to load any hour, any day (recommended; captures the most savings). Turn on only if the controller will run fixed discharge windows, such as a DR program commitment or a schedule-programmed EMS.', sug ? [' On this file the battery could need to discharge between ', h('b', {}, hhmm(sug.min)), ' and ', h('b', {}, hhmm(sug.max)), '.'] : null));
  } else {
    const chgWin = raw.chgMode === 'window';
    const hrInput = (key, label, extra) => h('div', { class: 'field' }, h('label', {}, label), h('input', { type: 'number', step: 0.5, min: 0, max: 24, value: +raw[key], 'aria-label': label, onchange: (e) => { const v = +e.target.value; if (Number.isFinite(v)) setSched({ [key]: Math.max(0, Math.min(24, v)) }); } }), extra);
    kids.push(h('div', { class: 'dgrid' },
      hrInput('disStart', 'Discharge from (hr)'),
      hrInput('disEnd', 'Discharge until (hr)', h('div', { class: 'hint' }, `${hhmm(+raw.disStart)} – ${hhmm(+raw.disEnd)}${+raw.disStart > +raw.disEnd ? ' (overnight)' : ''}`)),
      h('div', { class: 'field' }, h('label', {}, 'Charging'), h('select', { 'aria-label': 'Charging mode', onchange: (e) => setSched({ chgMode: e.target.value }) }, h('option', { value: 'auto', selected: !chgWin }, 'Anytime below target'), h('option', { value: 'window', selected: chgWin }, 'Only in a set window'))),
      chgWin ? hrInput('chgStart', 'Charge from (hr)') : null,
      chgWin ? hrInput('chgEnd', 'Charge until (hr)', h('div', { class: 'hint' }, `${hhmm(+raw.chgStart)} – ${hhmm(+raw.chgEnd)}${+raw.chgStart > +raw.chgEnd ? ' (overnight)' : ''}`)) : null,
      h('div', { class: 'field' }, h('label', {}, 'Applies in'), h('select', { 'aria-label': 'Months the schedule applies', onchange: (e) => setSched({ months: e.target.value }) }, [['all', 'All months'], ['summer', 'Summer only (Jun–Sep)'], ['winter', 'Winter only (Oct–May)']].map(([v, l]) => h('option', { value: v, selected: (raw.months || 'all') === v }, l))), h('div', { class: 'hint' }, 'other months dispatch automatically')),
      h('div', { class: 'field' }, h('label', {}, 'Days'), h('select', { 'aria-label': 'Days the schedule applies', onchange: (e) => setSched({ days: e.target.value }) }, [['all', 'All days'], ['weekdays', 'Weekdays only']].map(([v, l]) => h('option', { value: v, selected: (raw.days || 'all') === v }, l)))),
    ));
    if (sug) {
      const same = +raw.disStart === sug.s && +raw.disEnd === sug.e;
      kids.push(h('p', { class: 'small muted' }, `On this file the battery could need to discharge between ${hhmm(sug.min)} and ${hhmm(sug.max)} (any load within ${num(D.u.kw)} kW of a monthly peak) → suggested window ${hhmm(sug.s)}–${hhmm(sug.e)} loses nothing vs automatic `,
        same ? h('span', { class: 'badge ok' }, 'in use') : h('button', { class: 'btn small', type: 'button', onclick: () => setSched({ enabled: true, disStart: sug.s, disEnd: sug.e }) }, 'Use suggested')));
    }
    if (H.winLenHrs(raw.disStart, raw.disEnd) === 0) kids.push(h('div', { class: 'check-warn' }, h('b', {}, 'Zero-length discharge window'), ' — the battery never discharges. Fix the hours.'));
    const missed = [];
    for (const m of D.months) {
      const days = ctx.iv ? H.daysOfMonth(ctx.iv, m) : null;
      let peakH = null;
      let date = null;
      if (days) {
        let best = -1;
        days.forEach((d) => d.forEach((q) => { if (q.kW > best) { best = q.kW; peakH = q.h; date = q.d; } }));
      } else {
        const kw = ctx.a.profile.kw;
        const i = kw.indexOf(Math.max(...kw));
        peakH = i * ctx.a.profile.dtHours;
      }
      if (peakH == null || !H.schedForDate(raw, date)) continue;
      if (!H.schedInWin(peakH, raw.disStart, raw.disEnd)) missed.push(`${MON[m - 1]} (${num(D.holds[m].peak, 1)} kW at ${hhmm(peakH)})`);
    }
    if (missed.length) kids.push(h('div', { class: 'check-warn' }, '⚠ ', h('b', {}, `Peaks escape the window in: ${missed.join(', ')}. `), 'Those months cannot be shaved below the load that falls outside the schedule; the holds below already reflect that.'));
    if (chgWin) {
      const refill = H.winLenHrs(raw.chgStart, raw.chgEnd) * (D.u.chargeKw || D.u.kw) * (D.u.effC || 1);
      const need = D.u.usableKwh - H.reserveFloorKwh(D.u);
      if (refill < need - 0.5) kids.push(h('div', { class: 'check-warn' }, '⚠ ', h('b', {}, 'Charge window may not fully refill the battery'), ` (≈${num(refill)} kWh storable in ${num(H.winLenHrs(raw.chgStart, raw.chgEnd), 1)} h at ${num(D.u.chargeKw || D.u.kw)} kW vs ${num(need, 1)} kWh ${D.opt.reserve > 0 ? 'that can be discharged (usable minus the reserve)' : 'usable'}). The model assumes each day starts full — widen the window or expect shallower real-world holds.`));
    }
    kids.push(h('p', { class: 'small muted' }, 'The schedule applies to the sustainable holds and the dispatch charts. The demand-charge dollars on this tab assume automatic dispatch.'));
  }
  return opt('Dispatch schedule (optional)', { on: !!sc, status: sc ? `${hhmm(+sc.disStart)}–${hhmm(+sc.disEnd)} active` : 'automatic', children: kids });
}

function defaultSched(sug) {
  return { enabled: true, disStart: sug ? sug.s : 14, disEnd: sug ? sug.e : 21, chgMode: 'auto', chgStart: 21, chgEnd: 8, months: 'all', days: 'all' };
}

function carryCard(ctx, D) {
  const on = D.opt.carry;
  const exclusive = 'Can’t be combined with “Maximize discharge on lighter days” — turning this on turns that one off.';
  const kids = [h('label', { class: 'small', style: { cursor: 'pointer' } }, h('input', { type: 'checkbox', checked: on ? true : null, onchange: (e) => ctx.setDispatch({ carry: e.target.checked }) }), ' Model multi-day heat events')];
  if (!on) {
    kids.push(h('p', { class: 'small ink2' }, h('b', {}, 'Off (default)'), ' — each day is modeled starting fully charged (assumes a complete overnight recharge). Turn on to model a stretch of consecutive high-load days honestly, a more conservative view for sites prone to multi-day heat events. ', exclusive));
    // The default's blind spot: months where the carry-across-days hold is materially shallower.
    const alt = holdsFor(ctx, D.u, { ...D.opt, carry: true });
    const rows = [];
    let n = 0;
    for (const m of D.months) {
      const c = alt[m];
      const b = D.holds[m];
      if (!c || c.achievable == null) continue;
      n++;
      const d = c.achievable - b.achievable;
      if (d > Math.max(0.5, 0.03 * (b.peak || 0))) rows.push({ m, now: b.achievable, carry: c.achievable });
    }
    if (rows.length) {
      kids.push(h('div', { class: 'check-warn' }, '⚠ ', h('b', {}, `The “full recharge every night” assumption does not hold in ${rows.length} of ${n} months. `),
        'At these targets there is not enough room under the target (and not enough charge power) to refill the battery before the next day, so the holds are too deep. With charge carried across days they would be: ',
        rows.map((x, i) => [i ? ' · ' : '', h('b', {}, MON[x.m - 1]), ` ${num(x.carry, 1)} kW (now ${num(x.now, 1)})`]), '. ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); ctx.setDispatch({ carry: true }); } }, 'Model carry across days')));
    }
  } else {
    kids.push(h('p', { class: 'small ink2' }, 'Each day’s ending charge now carries into the next day instead of resetting to full. ', exclusive));
    kids.push(h('p', { class: 'small muted' }, 'Carry applies to the sustainable holds and dispatch charts. The demand-charge dollars on this tab assume each day starts full.'));
  }
  return opt('Carry battery charge across days (optional)', { on, status: on ? 'on' : 'off', children: kids });
}

function maxDailyCard(ctx, D) {
  const carry = D.opt.carry;
  const on = !!ctx.site.dispatch?.max_daily && !carry;
  const kids = [h('label', { class: 'small', style: { cursor: carry ? 'not-allowed' : 'pointer', opacity: carry ? 0.6 : 1 } },
    h('input', { type: 'checkbox', checked: on ? true : null, disabled: carry ? true : null, onchange: (e) => ctx.setDispatch({ max_daily: e.target.checked }) }), ' Discharge deeper when a day allows it')];
  if (carry) {
    kids.push(h('p', { class: 'small ink2' }, h('b', {}, 'Off — can’t be combined with “Carry battery charge across days”, which is on.'), ' Carry models a specific multi-day depletion path, and spending extra charge on one day just to look deeper would quietly break that result for the days after it. Turn off carry to use this instead.'));
  } else {
    kids.push(h('p', { class: 'small ink2' }, on ? 'Each day discharges to the deepest level it alone can sustain, never past the monthly target' : h('span', {}, h('b', {}, 'Off (default)'), ' — every day is capped at the same fixed monthly target, even on a day whose own peak never gets close to it. This only ever lets a day discharge deeper than the target, never past it'), D.opt.reserve > 0 ? ' and never into the reserve' : '', '. ', h('b', {}, 'It only changes what a lighter day does'), ' — it cannot lower a month’s peak, because the hardest day sets that.'));
  }
  return opt('Maximize discharge on lighter days (optional)', { on, status: on ? 'on' : carry ? 'off (carry is on)' : 'off', children: kids });
}

// ============================================================================================
// Daily dispatch by month
// ============================================================================================

function dayOptionsOf(ctx, D, m, target) {
  if (!ctx.iv) return [];
  const days = H.daysOfMonth(ctx.iv, m);
  if (!days) return [];
  let worstKey = null;
  let best = -Infinity;
  days.forEach((d) => d.forEach((q) => { if (q.kW > best) { best = q.kW; worstKey = normKey(q.d); } }));
  const opts = days.map((prof) => {
    const key = isoKey(prof[0].d);
    return { key, nk: normKey(prof[0].d), label: `${MON[m - 1]} ${+key.slice(8)}`, peakKW: Math.max(...prof.map((q) => q.kW)), profile: prof, isWorst: normKey(prof[0].d) === worstKey };
  });
  return opts;
}

function dispatchCards(ctx, D) {
  const { ui, a, r } = ctx;
  if (!D.months.length) return [h('div', { class: 'card empty' }, 'No peak data to dispatch against. Load a meter interval file (Interval data tab), or enter the site’s peak demand.')];
  const m = D.months.includes(ui.month) ? ui.month : D.defaultMonth;
  ui.month = m;
  const x = D.holds[m];
  const target = D.targetOf(m);
  const isOv = D.opt.targets[m] != null && Number.isFinite(+D.opt.targets[m]);
  const below = target < x.achievable - 0.05;
  const { u, dt, opt: O } = D;
  const days = dayOptionsOf(ctx, D, m, target);
  const interval = !!days.length;
  // The worst day (design day without interval data) and the profile of the day shown.
  const worstOpt = days.find((d) => d.isWorst) || null;
  const design = ctx.a.profile.kw.map((v, i) => ({ h: i * ctx.a.profile.dtHours, kW: v, d: null }));

  // One walk over the month: the day whose charge gets lowest, and the month's totals (as the workbench does).
  const agg = { days: days.length, eDis: 0, eChg: 0, notHeld: 0, idle: 0 };
  let deepestKey = null;
  if (interval) {
    let soc = u.usableKwh;
    let lowest = Infinity;
    for (const d of days) {
      const sd = H.schedForDate(O.sched, d.nk);
      const cap = H.maxDischargeCapFor(d.profile, u, dt, sd, target, O);
      const r0 = H.dispatchProfileFrom(d.profile, cap, u, dt, sd, O.carry ? soc : u.usableKwh);
      if (O.carry) soc = r0.socEnd;
      if (r0.minSOC < lowest - 1e-6) { lowest = r0.minSOC; deepestKey = d.key; }
      agg.eDis += r0.eDis;
      agg.eChg += r0.eChg;
      if (r0.eDis <= 1e-9) agg.idle++;
      if (!r0.held) agg.notHeld++;
    }
    days.forEach((d) => { d.isDeepest = d.key === deepestKey; });
  }
  const shown = ui.day && days.find((d) => d.key === ui.day) ? days.find((d) => d.key === ui.day) : null;
  const prof = shown ? shown.profile : worstOpt ? worstOpt.profile : design;
  const dateKey = shown ? shown.nk : worstOpt ? worstOpt.nk : null;
  const sched = H.schedForDate(O.sched, dateKey);
  const dayCap = H.maxDischargeCapFor(prof, u, dt, sched, target, O);
  let sim;
  let startSoc = null;
  if (O.carry && interval) {
    let soc = u.usableKwh;
    let res = null;
    for (const d of days) {
      const sd = H.schedForDate(O.sched, d.nk);
      startSoc = soc;
      res = H.dispatchProfileFrom(d.profile, target, u, dt, sd, soc);
      soc = res.socEnd;
      if (d.nk === dateKey) break;
    }
    sim = res || H.dispatchProfile(prof, dayCap, u, dt, sched);
  } else sim = H.dispatchProfile(prof, dayCap, u, dt, sched);

  const monthSel = h('select', { 'aria-label': 'Billing month', onchange: (e) => { ui.month = +e.target.value; ui.day = null; ctx.rerender(); } },
    D.months.map((mm) => h('option', { value: mm, selected: mm === m }, `${MON[mm - 1]}${interval && ctx.iv.months[mm]?.days?.length ? ' — worst day ' + (dayOptionsOf(ctx, D, mm).find((d) => d.isWorst)?.key || '') : ''}`)));
  const deepest = days.find((d) => d.isDeepest);
  const daySel = days.length
    ? h('select', { 'aria-label': 'Day shown on the chart', onchange: (e) => { ui.day = e.target.value || null; ctx.rerender(); } },
      h('option', { value: '', selected: !shown }, `Worst day (sets the target) — ${worstOpt ? worstOpt.key : ''}${deepest && deepest.isWorst ? ' (also lowest charge all month)' : ''}`),
      days.map((d) => h('option', { value: d.key, selected: !!shown && d.key === shown.key }, `${d.label} — peak ${num(d.peakKW, 1)} kW${d.isWorst ? (d.isDeepest ? ' (same as worst day; also lowest charge)' : ' (same as worst day)') : d.isDeepest ? ' (lowest charge all month)' : ''}`)))
    : h('span', { class: 'small muted' }, 'only the design day is available (load a meter interval file to browse the real days)');
  const targetInput = h('input', { type: 'number', min: 0, step: 1, value: Math.round(target * 10) / 10, 'aria-label': 'Peak target for this month (kW)', onchange: (e) => setTarget(ctx, m, e.target.value) });
  const shownLabel = shown ? `${shown.label}` : interval ? `${MON[m - 1]} worst day` : 'design day';

  // sustain line
  const sc = interval ? H.monthSustainCheck(days.map((d) => d.profile), target, u, dt, O.sched, O.carry) : null;
  let sustain;
  if (sc && sc.holdsAll) sustain = h('div', { class: 'check-ok' }, '✓ ', h('b', {}, `Holds all ${sc.days} days of ${MON[m - 1]}.`), ` Dispatched at ${num(target, 1)} kW — highest shaved peak all month: ${num(sc.worstAfter, 1)} kW.`);
  else if (sc) sustain = h('div', { class: 'check-warn' }, '⚠ ', h('b', {}, `Not sustainable all month at ${num(target, 1)} kW.`), ` Highest shaved peak across all ${sc.days} days: ${num(sc.worstAfter, 1)} kW (binding day ${sc.bindingDate || ''}) — raise the target to ≥ ${num(sc.worstAfter, 1)} kW.`);
  else sustain = h('div', { class: 'check-info' }, 'Showing the design day only. Load a meter interval file to verify the target across every day of the month.');

  // chart data
  const hours = prof.map((q) => q.h);
  const load = prof.map((q) => q.kW);
  const bands = [];
  if (sched) {
    const a0 = +sched.disStart;
    const b0 = +sched.disEnd;
    if (a0 < b0) bands.push([a0, b0]);
    else if (a0 > b0) bands.push([a0, 24], [0, b0]);
  }
  const caps = load.map(() => target);
  const simView = {
    shaved: sim.shaved.map((q) => q[1]),
    flow: sim.orig.map((q, i) => q[1] - sim.shaved[i][1]),
    soc: sim.soc.map((q) => q[1]),
    peakBefore: Math.max(...load),
    peakAfter: sim.achieved,
    maxDischarge: sim.maxDis,
    energyUsed: sim.eDis,
    lowestSoc: sim.minSOC,
    held: sim.held,
  };
  const avail = Math.max(0, sim.E - sim.floor) * (sim.effD || 1);
  const tile = (label, value, unit, sub, cls = '') => h('div', { class: `dtile ${cls}` }, h('div', { class: 'lab' }, label), h('div', { class: 'val' }, value, unit ? h('span', { class: 'u' }, ` ${unit}`) : null), sub ? h('div', { class: 'sub' }, sub) : null);
  const atFloor = sim.floor > 0 && sim.minSOC <= sim.floor + 0.05;

  const viewSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Dispatch view' },
    [['workbench', 'Workbench target (kW)'], ['plan', 'Planned target (savings basis)']].map(([v, l]) => h('button', { type: 'button', 'aria-pressed': ui.basis === v ? 'true' : 'false', onclick: () => { ui.basis = v; ctx.rerender(); } }, l)));
  const dayMonthSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Single day or monthly totals' },
    [['day', 'Single day'], ['month', 'Monthly totals']].map(([v, l]) => h('button', { type: 'button', 'aria-pressed': ui.view === v ? 'true' : 'false', onclick: () => { ui.view = v; ctx.rerender(); } }, l)));

  const cards = [];
  if (ui.basis === 'plan') {
    cards.push(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Daily dispatch — by month')), h('div', { class: 'btn-row' }, viewSeg), h('p', { class: 'small ink2', style: { marginTop: '8px' } }, 'The target the demand-charge dollars assume: the sustainable hold after the capture factor and any DR event days.')));
    cards.push(...ctx.planView(m, (mm) => { ui.month = mm; ctx.rerender(); }, D.months));
    return cards;
  }

  const head = h('div', { class: 'card-head' }, h('h2', {}, 'Daily dispatch — by month'), h('span', { class: `badge ${sim.held ? 'ok' : 'caution'}` }, sim.held ? 'Holds target' : 'Undersized'));
  const body = [head, h('div', { class: 'btn-row', style: { marginBottom: '10px' } }, viewSeg, dayMonthSeg)];
  body.push(h('div', { class: 'dgrid' },
    h('div', { class: 'field' }, h('label', {}, 'Billing month'), monthSel),
    ui.view === 'month' ? null : h('div', { class: 'field' }, h('label', {}, 'Day shown on chart'), daySel),
    h('div', { class: 'field' }, h('label', {}, 'Peak target for this month (kW)'), targetInput,
      h('div', { class: 'hint' }, `sustainable hold ${num(x.achievable, 1)} kW · `, below ? h('span', { class: 'bad-text' }, 'below hold — not sustainable') : isOv ? 'manual override' : 'auto'))));
  if (ui.view === 'month') {
    const avgDis = agg.days ? agg.eDis / agg.days : 0;
    const cycles = u.usableKwh ? agg.eDis / u.usableKwh : 0;
    body.push(h('p', { class: 'small ink2' }, interval ? `Totals across all ${agg.days} real days in ${MON[m - 1]} at the ${num(target, 1)} kW target${O.maxDaily ? ', with “Maximize discharge on lighter days” on, so lighter days discharge deeper than the target' : ''}. ` : 'Totals need interval data. ',
      O.carry ? 'Battery charge is carried across days, so charged/discharged reflect one continuous month.' : 'Each day is modeled starting fully charged (a full overnight recharge is assumed and not counted in “charged” below); turn on “Carry battery charge across days” to model the whole month continuously.'));
    body.push(interval ? h('div', { class: 'dtiles' },
      tile('Days the battery never discharged', String(agg.idle), `of ${agg.days} days`, agg.idle && !O.maxDaily && !O.carry ? 'turn on “Maximize discharge” to put them to work' : ''),
      tile('Average daily discharge', num(avgDis), 'kWh/day'),
      tile('Total discharged this month', num(agg.eDis), 'kWh'),
      tile('Total charged this month', num(agg.eChg), 'kWh'),
      tile('Equivalent full cycles', num(cycles, 1), 'cycles', `of ${num(u.usableKwh)} kWh usable`),
      tile('Days target not held', String(agg.notHeld), `of ${agg.days} days`, agg.notHeld ? 'raise target or add capacity' : ''),
    ) : h('div', { class: 'check-info' }, 'No interval data for this month.'));
    cards.push(h('div', { class: 'card' }, ...body));
    return cards;
  }
  body.push(h('p', { class: 'small ink2' }, `${shown ? shown.key : worstOpt ? worstOpt.key : 'Design day'}: the battery discharges to hold this day under ${num(target, 1)} kW, then recharges off-peak.${shown && !shown.isWorst ? ' Browsing a different day never changes the target; it stays set by the worst day.' : ''}`));
  body.push(dispatchDayChart({ load, sim: simView, caps, dtHours: dt, label: shown ? shown.key : worstOpt ? worstOpt.key : '', hours, bands, dayCap }));
  body.push(auditTable(ctx, sim, shown ? shown.key : worstOpt ? worstOpt.key : 'design', m, D, target, days));
  cards.push(h('div', { class: 'card' }, ...body));
  cards.push(h('div', { class: 'grid-2' },
    h('div', { class: 'card' }, h('h3', {}, `State of charge — ${shownLabel}`), socChart({ sim: simView, storedKwh: sim.E, dtHours: dt, hours, floor: sim.floor, startKwh: startSoc })),
    h('div', { class: 'card' }, h('h3', {}, `Dispatch check — ${shownLabel}`),
      h('div', { class: 'dtiles' },
        tile('Target held?', sim.held ? 'Yes' : 'No', null, sim.held ? '' : 'raise target', sim.held ? 'good' : 'bad'),
        tile('Peak after shave', num(sim.achieved, 1), 'kW', `from ${num(Math.max(...load), 1)} kW`),
        tile('Max discharge', num(sim.maxDis, 1), 'kW', `of ${num(sim.P)} kW`),
        tile('Energy used', num(sim.eDis), 'kWh', `of ${num(avail)} kWh deliverable${sim.floor > 0 ? ' after reserve' : ''}`),
        tile('Lowest charge', num(sim.minSOC), 'kWh', sim.floor > 0 ? `reserve floor ${num(sim.floor)} kWh${atFloor ? ' — reached' : ''}` : sim.minSOC <= 0 ? 'depleted' : ''),
      ), sustain)));
  return cards;
}

function setTarget(ctx, m, v) {
  const cur = { ...(ctx.site.dispatch?.month_targets || {}) };
  if (v === '' || v == null || Number.isNaN(+v)) delete cur[m];
  else cur[m] = Math.max(0, +v);
  ctx.setDispatch({ month_targets: cur });
}

/** Every interval of the shown day, with CSV downloads for the day and the whole month. */
function auditTable(ctx, sim, dayKey, m, D, target, days) {
  const rows = sim.orig.map((q, i) => {
    const load = q[1];
    const grid = sim.shaved[i][1];
    const batt = load - grid;
    return h('tr', {}, h('td', {}, hhmm(q[0])), h('td', { class: 'num' }, num(load, 1)), h('td', { class: `num ${batt > 0.05 ? 'pos' : batt < -0.05 ? 'neg' : 'zero'}` }, `${batt > 0.05 ? '+' : ''}${num(batt, 1)}`), h('td', { class: 'num' }, h('b', {}, num(grid, 1))), h('td', { class: 'num' }, num(sim.soc[i][1])));
  });
  const meta = (extra = []) => [
    [],
    [csvTxt('Target (kW) — the fixed monthly commitment, unaffected by maximize mode'), csvNum(target, 1)],
    ...extra,
    ['Unit', csvTxt(ctx.r.config.label)],
    ['Usable kWh / discharge kW / charge kW', `${csvNum(D.u.usableKwh)} / ${csvNum(D.u.kw)} / ${csvNum(D.u.chargeKw || D.u.kw)}`],
    ['Reserve capacity held back (% of usable kWh)', csvNum(D.opt.reserve * 100, 1)],
    ['Reserve floor (kWh) — never discharged below; the Battery charge column is total stored energy and includes it', csvNum(H.reserveFloorKwh(D.u))],
  ];
  const site = (ctx.site.id || ctx.site.name || 'site').replace(/[^\w-]+/g, '_');
  const dlDay = () => {
    const out = [['Time', 'Site load (kW)', 'Battery kW (+discharge / -charge)', 'Grid draw after battery (kW)', 'Battery charge (kWh)']];
    sim.orig.forEach((q, i) => out.push([hhmm(q[0]), csvNum(q[1], 1), csvNum(q[1] - sim.shaved[i][1], 1), csvNum(sim.shaved[i][1], 1), csvNum(sim.soc[i][1])]));
    out.push(...meta([['Billed peak = highest grid draw (kW)', csvNum(sim.achieved, 1)]]));
    download(`${site}_${dayKey}_dispatch.csv`, out.map((r) => r.join(',')).join('\n'), 'text/csv');
  };
  const dlMonth = () => {
    if (!days.length) return;
    const out = [['Date', 'Time', 'Site load (kW)', 'Battery kW (+discharge / -charge)', 'Grid draw after battery (kW)', 'Battery charge (kWh)', 'Day cap used (kW)']];
    let soc = D.u.usableKwh;
    let maxGrid = 0;
    let dis = 0;
    let chg = 0;
    let maximized = 0;
    for (const d of days) {
      const sd = H.schedForDate(D.opt.sched, d.nk);
      const cap = H.maxDischargeCapFor(d.profile, D.u, D.dt, sd, target, D.opt);
      if (cap < target - 0.05) maximized++;
      const s1 = H.dispatchProfileFrom(d.profile, cap, D.u, D.dt, sd, D.opt.carry ? soc : D.u.usableKwh);
      soc = s1.socEnd;
      s1.orig.forEach((q, i) => {
        const g = s1.shaved[i][1];
        const b = q[1] - g;
        if (g > maxGrid) maxGrid = g;
        if (b > 0) dis += b * D.dt;
        else chg += -b * D.dt;
        out.push([d.key, hhmm(q[0]), csvNum(q[1], 1), csvNum(b, 1), csvNum(g, 1), csvNum(s1.soc[i][1]), csvNum(cap, 1)]);
      });
    }
    out.push([], ['Month', MON[m - 1]]);
    out.push([csvTxt('Target (kW) — the fixed monthly commitment, unaffected by maximize mode'), csvNum(target, 1)]);
    out.push(['Billed peak = highest grid draw all month (kW)', csvNum(maxGrid, 1)], ['Total discharged (kWh)', csvNum(dis)], ['Total charged (kWh)', csvNum(chg)], ['Days simulated', days.length]);
    out.push(['SOC carried across days?', D.opt.carry ? 'Yes' : 'No — each day assumed to fully recharge overnight']);
    out.push(['Maximize discharge on lighter days?', D.opt.maxDaily ? `Yes — ${maximized} of ${days.length} days discharged deeper than the monthly target` : D.opt.carry && ctx.site.dispatch?.max_daily ? 'Off — disabled while SOC is carried across days' : 'No — every day capped at the same fixed monthly target']);
    out.push(...meta().slice(2));
    download(`${site}_${MON[m - 1]}_full-month_dispatch.csv`, out.map((r) => r.join(',')).join('\n'), 'text/csv');
  };
  return h('details', { class: 'audit' },
    h('summary', {}, `🔍 Audit — see every interval (${dayKey})`),
    h('div', { class: 'audit-head' },
      h('p', { class: 'small muted' }, 'Every interval of this day on the meter data: the load, what the battery does (+ discharge / − charge), the resulting grid draw, and the battery’s stored charge. The month’s billed peak is the highest Grid value. Nothing is estimated; trace any row by hand.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', type: 'button', onclick: dlDay }, '⇩ Download this day (CSV)'),
        days.length ? h('button', { class: 'btn small', type: 'button', onclick: dlMonth, title: 'Every real day this month, not just the worst one' }, '⇩ Download the whole month (CSV)') : null)),
    h('div', { class: 'audit-scroll' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Time', 'Load kW', 'Battery kW', 'Grid kW', 'Charge kWh'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
      h('tbody', {}, ...rows))));
}

// ============================================================================================
// Per-month peak targets
// ============================================================================================

function targetsCard(ctx, D) {
  const { ui, r } = ctx;
  const md = r.monthDetail || {};
  const m0 = D.months.includes(ui.month) ? ui.month : D.defaultMonth;
  const primary = (dm) => dm.comps.find((c) => !c.window) || dm.comps.reduce((b, c) => (c.usd > b.usd ? c : b), dm.comps[0]);
  const rows = Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
    const x = D.holds[m];
    const dm = md[m];
    if (!x || x.achievable == null) return h('tr', {}, h('td', {}, MON[m - 1]), h('td', { class: 'muted', colspan: 5 }, 'no data'));
    const ov = D.opt.targets[m] != null && Number.isFinite(+D.opt.targets[m]);
    const t = D.targetOf(m);
    const below = t < x.achievable - 0.05;
    return h('tr', { class: `click${m === m0 ? ' sel' : ''}${below ? ' below' : ov ? ' ov' : ''}`, onclick: () => { ui.month = m; ui.day = null; ctx.rerender(); } },
      h('td', {}, MON[m - 1], m === m0 ? ' ◀' : '', below ? h('span', { class: 'bad-text', title: 'not sustainable' }, ' ⚠') : null, dm?.eventLimited ? h('span', { class: 'badge caution', style: { marginLeft: '6px' }, title: 'DR event days take the battery’s energy, so the planned demand savings are lower than the hold implies' }, 'DR events') : null),
      h('td', { class: 'num' }, num(x.peak, 1)),
      h('td', { class: 'num' }, num(x.achievable, 1)),
      h('td', { class: 'num' }, h('input', { type: 'number', min: 0, step: 1, class: `tgt${below ? ' below' : ''}`, value: Math.round(t * 10) / 10, 'aria-label': `Target for ${MON[m - 1]} (kW)`, title: ov ? 'manual override' : '', onclick: (e) => e.stopPropagation(), onchange: (e) => setTarget(ctx, m, e.target.value) })),
      h('td', { class: 'num' }, `${num(Math.max(0, x.peak - t), 1)} kW`),
      h('td', { class: 'num' }, dm ? usd(dm.usd) : h('span', { class: 'muted' }, 'no demand charge')));
  });
  const demandUsd = D.months.reduce((n, m) => n + (md[m]?.usd || 0), 0);
  const basis = D.holds[D.months[0]]?.basis === 'interval' ? 'Each target is the lowest level the battery holds on every day of that month (full interval file).' : 'Targets are design-day estimates; load a meter interval file to verify across all days.';
  const anyOv = Object.keys(D.opt.targets).length > 0;
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Per-month peak targets & savings'), anyOv ? h('button', { class: 'btn small', type: 'button', onclick: () => ctx.setDispatch({ month_targets: {} }) }, 'Reset all to auto') : h('span', { class: 'small muted' }, 'Click a row to chart that month')),
    h('p', { class: 'small ink2' }, `${basis} Edit a target to override it; push one below the sustainable hold (turns red) to find the make-or-break point. `,
      D.opt.sched ? h('b', {}, `Dispatch schedule active (${hhmm(+D.opt.sched.disStart)}–${hhmm(+D.opt.sched.disEnd)}): holds reflect it. `) : null,
      'Demand savings are the Atlas valuation of the selected rate’s charges at the planned target, so they do not move with a target typed here.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'pm-table' },
      h('thead', {}, h('tr', {}, ['Month', 'Peak', 'Sustainable hold', 'Target (kW)', 'kW reduction', 'Demand savings'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
      h('tbody', {}, ...rows),
      h('tfoot', {}, h('tr', {}, h('td', {}, h('b', {}, 'Year')), h('td', {}), h('td', { class: 'num small muted' }, `avg cut ${Math.round((avgCut(D.holds, D.months) || 0) * 100)}%`), h('td', {}), h('td', {}), h('td', { class: 'num' }, h('b', {}, usd(demandUsd))))))));
}
