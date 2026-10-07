// Demand savings tab: the cost-free model. Pick a battery system, choose how demand is priced (the selected
// rate, or the customer's own bills typed in month by month), and see how far the battery lowers each month's
// peak and what that is worth. The daily dispatch and the dispatch options sit below it, folded away.
// The numbers come from engine/demand-savings.js (bills: the workbench's bill model) and engine/hold.js.
import { h, num, usd } from '../ui.js';
import { monthlySavingsChart } from '../dispatch-chart.js';
import * as DS from '../engine/demand-savings.js';
import { setTarget, settingsSummary } from './dispatch-tab.js';

const MON = DS.MONTHS;

/** "$1,234.50" / "1 234" / "(12)" → number, else null. */
export function parseAmount(s) {
  const t = String(s ?? '').replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (t === '' || !/^-?\d*\.?\d+$/.test(t)) return null;
  return Number(t);
}

/**
 * Spread pasted spreadsheet text over the months from `start`: one row per month; in the charges column a row
 * may carry "$ <tab> kW". Non-numeric cells (month names) are skipped. Returns { m: { usd?, kw? } } or null
 * when the text is a single value (an ordinary paste).
 */
export function pastedMonths(text, start, key) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2 && !/\t/.test(lines[0] || '')) return null;
  const out = {};
  lines.forEach((line, i) => {
    const m = start + i;
    if (m > 12) return;
    const vals = line.split('\t').map(parseAmount).filter((v) => v != null);
    if (!vals.length) return;
    if (key === 'kw') out[m] = { kw: vals[0] };
    else out[m] = vals.length > 1 ? { usd: vals[0], kw: vals[1] } : { usd: vals[0] };
  });
  return Object.keys(out).length ? out : null;
}

/**
 * ctx = { site, a, sel, dm, sec, iv, ui, setBills(patch), setDispatch(patch), select(configId), rerender(), goRates() }
 *   dm = DS.demandModel for the selected system (with the tab's month targets), sec = dispatchSection(...)
 */
export function demandTab(ctx) {
  return h('div', { class: 'demand-tab' }, systemCard(ctx), chargesCard(ctx), monthsCard(ctx), fold(ctx, 'dispatch'), fold(ctx, 'settings'));
}

function systemCard(ctx) {
  const { a, sel } = ctx;
  const sug = a.recommended;
  const c = sel.config;
  const usable = c.usableKwh ?? c.kwh * a.assumptions.usable_fraction;
  const fact = (k, v) => h('div', { class: 'sys-fact' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  const why = a.costsKnown
    ? 'Suggested: the highest 10-year NPV of the feasible systems, at your installed costs.'
    : 'Suggested: the smallest system within 3 points of the deepest average monthly peak cut any option reaches. Costs are ignored.';
  return h('div', { class: 'card sys-card' },
    h('div', { class: 'sys-row' },
      h('div', { class: 'field sys-pick' }, h('label', { for: 'sys-select' }, 'Battery system'),
        h('select', { id: 'sys-select', 'aria-label': 'Battery system', onchange: (e) => ctx.select(e.target.value) },
          a.results.map((r) => h('option', { value: r.config.id, selected: r === sel ? true : null }, `${r === sug ? '★ ' : ''}${r.config.label} — ${Math.round(r.peakCut.pct * 100)}% peak cut · ${usd(r.demand.total)}/yr`)))),
      h('div', { class: 'sys-facts' }, fact('Power', `${num(c.kw)} kW`), fact('Usable energy', `${num(usable)} kWh`), fact('Duration', `${num(c.kw ? usable / c.kw : 0, 1)} h`))),
    h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, sel === sug ? `★ ${why}` : [`★ ${sug.config.label}. ${why} `, h('button', { class: 'linklike', type: 'button', onclick: () => ctx.select(sug.config.id) }, 'Use it')]),
    ctx.sec.system,
  );
}

function chargesCard(ctx) {
  const { site, a, dm } = ctx;
  const billMode = !!site.bills?.use;
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Price demand with' },
    [[false, 'Tariff rates'], [true, 'Customer bills']].map(([v, l]) => h('button', { type: 'button', 'aria-pressed': billMode === v ? 'true' : 'false', onclick: () => ctx.setBills({ use: v }) }, l)));
  const body = [];
  if (!billMode) {
    const t = a.tariff;
    const charges = (t?.demand_charges || []).filter((d) => d.basis !== 'coincident' && d.basis !== 'contract');
    const months = (d) => (d.months?.length && d.months.length < 12 ? ` (${d.months.map((m) => MON[m - 1]).join(', ')})` : '');
    body.push(t
      ? h('div', { class: 'small ink2' }, h('b', {}, t.name), charges.length
        ? h('ul', { class: 'rate-list' }, charges.map((d) => h('li', {}, `${d.label}: `, typeof d.rate_usd_per_kw_month === 'number' ? h('b', {}, `$${num(d.rate_usd_per_kw_month, 2)}/${d.basis === 'daily' ? 'kW-day' : 'kW-mo'}`) : h('span', { class: 'warn-strong' }, 'no rate'), months(d), d.window ? ` · ${d.window.start}:00–${d.window.end}:00` : '')))
        : h('div', { class: 'muted' }, 'This rate has no demand charges.'))
      : h('div', { class: 'small warn-strong' }, 'No rate selected. Pick one in the form, or price demand from the customer’s bills.'));
    body.push(h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, 'Have the customer’s bills? Choose ', h('b', {}, 'Customer bills'), ' and type each month’s demand charges; every month is then valued from its own bill. ',
      t ? h('button', { class: 'linklike', type: 'button', onclick: ctx.goRates }, 'Review or override the tariff rates') : null));
  } else {
    const bills = DS.billsOf(site);
    const defRatchet = DS.tariffRatchet(a.tariff);
    body.push(h('div', { class: 'bill-tools' },
      h('div', { class: 'field' }, h('label', {}, 'Demand rate, every month ($/kW)'),
        h('input', { type: 'text', inputmode: 'decimal', placeholder: 'e.g. 18.50', 'aria-label': 'Demand rate every month ($/kW)', value: bills.flatRate ?? '', onchange: (e) => ctx.setBills({ rate_usd_per_kw: parseAmount(e.target.value) }) }),
        h('div', { class: 'hint' }, 'Prices every month that has no charges of its own below.')),
      h('div', { class: 'field' }, h('label', {}, 'Billing floor (ratchet) %'),
        h('input', { type: 'number', min: 0, max: 100, step: 1, 'aria-label': 'Billing floor (ratchet) percent', value: site.bills?.ratchet_pct ?? '', placeholder: String(Math.round(defRatchet * 100)), onchange: (e) => ctx.setBills({ ratchet_pct: e.target.value === '' ? null : Math.max(0, Math.min(100, +e.target.value)) }) }),
        h('div', { class: 'hint' }, defRatchet > 0 ? `Blank uses this rate’s ${Math.round(defRatchet * 100)}% ratchet${a.tariff?.ratchet?.applies_to ? ` (${String(a.tariff.ratchet.applies_to).split(/[.:;(]/)[0].trim()})` : ''}.` : 'No month bills below this % of the year’s highest billed peak. Blank = none.')),
      Object.keys(bills.months).length || bills.flatRate != null ? h('button', { class: 'btn small', type: 'button', style: { alignSelf: 'center' }, onclick: () => { if (confirm('Clear the demand rate and every month’s bill entries?')) ctx.setBills({ months: {}, rate_usd_per_kw: null }); } }, 'Clear bills') : null,
    ));
    body.push(h('p', { class: 'small muted', style: { margin: '8px 0 0' } }, 'Enter one demand rate, or each month’s ', h('b', {}, 'demand charges ($)'), ' and ', h('b', {}, 'billed demand (kW)'), ' from the bills in the table below. You can paste a column straight from a spreadsheet (one row per month, starting at the month you paste into). Billed kW defaults to the metered peak.'));
  }
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Demand charges'), seg), ...body);
}

function monthsCard(ctx) {
  const { site, a, dm, ui } = ctx;
  const billMode = !!site.bills?.use;
  const rows = dm.rows.filter((r) => !r.missing);
  const sel = rows.some((r) => r.m === ui.month) ? ui.month : rows.reduce((b, r) => (r.peak > (b?.peak ?? -1) ? r : b), null)?.m;
  const pick = (m) => { ui.month = m; ui.day = null; ctx.rerender(); };
  const chart = monthlySavingsChart({ months: dm.rows.map((r) => ({ month: r.m, name: MON[r.m - 1], usd: r.savings || 0, reduction: r.reduction || 0 })), selected: sel, onSelect: pick });
  const basis = dm.holds[rows[0]?.m]?.basis === 'interval' ? 'interval data, every day of the month' : 'design-day estimate';
  let table;
  let notes;
  if (billMode) {
    const bills = DS.billsOf(site);
    const setMonth = (m, patch) => {
      const cur = { ...(site.bills?.months || {}) };
      const next = { ...(cur[m] || {}), ...patch };
      if (next.usd == null && next.kw == null) delete cur[m];
      else cur[m] = next;
      ctx.setBills({ months: cur });
    };
    const onPaste = (m, key) => (e) => {
      const got = pastedMonths(e.clipboardData?.getData('text'), m, key);
      if (!got) return;
      e.preventDefault();
      const cur = { ...(site.bills?.months || {}) };
      for (const [mm, v] of Object.entries(got)) cur[mm] = { ...(cur[mm] || {}), ...v };
      ctx.setBills({ months: cur });
    };
    const body = dm.rows.map((r) => {
      if (r.missing) return h('tr', {}, h('td', {}, MON[r.m - 1]), h('td', { class: 'muted', colspan: 6 }, 'no load data'));
      const b = bills.months[r.m] || {};
      const below = r.target < r.achievable - 0.05;
      return h('tr', { class: `click${r.m === sel ? ' sel' : ''}${below ? ' below' : r.override ? ' ov' : ''}`, onclick: (e) => { if (e.target.tagName !== 'INPUT') pick(r.m); } },
        h('td', {}, MON[r.m - 1]),
        h('td', { class: 'num' }, h('input', { type: 'text', inputmode: 'decimal', class: 'bill-in', 'aria-label': `Demand charges ${MON[r.m - 1]} ($)`, value: b.usd ?? '', placeholder: r.flat ? num(r.rate * r.before, 0) : '$', title: r.flat ? 'From the demand rate; type the bill’s amount to override' : null, onchange: (e) => setMonth(r.m, { usd: parseAmount(e.target.value) }), onpaste: onPaste(r.m, 'usd') })),
        h('td', { class: 'num' }, h('input', { type: 'text', inputmode: 'decimal', class: 'bill-in', 'aria-label': `Billed demand ${MON[r.m - 1]} (kW)`, value: b.kw ?? '', placeholder: num(r.peak, 1), onchange: (e) => setMonth(r.m, { kw: parseAmount(e.target.value) }), onpaste: onPaste(r.m, 'kw') })),
        h('td', { class: 'num' }, r.rate != null ? [`$${num(r.rate, 2)}`, r.estimated ? h('span', { class: 'muted', title: 'No charges entered for this month: the average $/kW of the months entered' }, ' est.') : null] : h('span', { class: 'muted' }, '—')),
        h('td', { class: 'num' }, h('input', { type: 'number', min: 0, step: 1, class: `tgt${below ? ' below' : ''}`, 'aria-label': `Target for ${MON[r.m - 1]} (kW)`, title: `Sustainable hold ${num(r.achievable, 1)} kW${r.override ? ' · manual target' : ''}`, value: Math.round(r.target * 10) / 10, onchange: (e) => setTarget({ site, setDispatch: ctx.setDispatch }, r.m, e.target.value) })),
        h('td', { class: 'num' }, num(r.after, 1), r.floorBinds ? h('span', { class: 'muted', title: 'Billed at the ratchet floor' }, ' floor') : null),
        h('td', { class: 'num' }, r.savings != null ? h('b', {}, usd(r.savings)) : h('span', { class: 'muted' }, '—')),
      );
    });
    const enteredUsd = Object.values(bills.months).reduce((n, x) => n + (x.usd || 0), 0);
    table = h('table', { class: 'pm-table bill-table' },
      h('thead', {}, h('tr', {}, ['Month', 'Demand charges ($)', 'Billed demand (kW)', '$/kW', 'Battery holds peak to (kW)', 'Billed after (kW)', 'Savings'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
      h('tbody', {}, body),
      h('tfoot', {}, h('tr', {}, h('td', {}, h('b', {}, 'Year')), h('td', { class: 'num' }, enteredUsd ? usd(enteredUsd) : ''), h('td', {}), h('td', {}), h('td', { class: 'num small muted' }, `avg cut ${Math.round(dm.depth.pct * 100)}%`), h('td', {}), h('td', { class: 'num' }, h('b', {}, usd(dm.total))))));
    notes = [
      h('p', { class: 'small ink2' }, h('b', {}, 'Savings = (billed demand − billed demand with the battery) × $/kW'), `, the Site Analysis Workbench’s bill model. $/kW is each month’s demand charges ÷ billed demand. The battery holds each month’s peak to the target on every day of the month (${basis}); push a target below the sustainable hold (it turns red) and the month is billed at the peak actually held, so you can find the make-or-break point.`),
      dm.ratchetPct > 0 ? h('p', { class: 'small ink2' }, `Billing floor ${Math.round(dm.ratchetPct * 100)}%${dm.ratchetFromTariff ? ' (from the rate)' : ''}: no month bills below ${num(dm.floor, 1)} kW, ${Math.round(dm.ratchetPct * 100)}% of the highest peak the battery holds all year.`) : null,
      dm.entered === 0 ? h('div', { class: 'check-info' }, 'Enter a demand rate, or at least one month’s demand charges, to see the savings.') : dm.estimated ? h('p', { class: 'small muted' }, `${dm.estimated} month${dm.estimated > 1 ? 's' : ''} without charges ${dm.estimated > 1 ? 'use' : 'uses'} the average $/kW of the ${dm.entered} entered (marked est.).`) : null,
    ];
  } else {
    const body = dm.rows.map((r) => {
      if (r.missing) return h('tr', {}, h('td', {}, MON[r.m - 1]), h('td', { class: 'muted', colspan: 4 }, 'no load data'));
      return h('tr', { class: `click${r.m === sel ? ' sel' : ''}`, onclick: () => pick(r.m) },
        h('td', {}, MON[r.m - 1], r.eventLimited ? h('span', { class: 'badge caution', style: { marginLeft: '6px' }, title: 'Demand-response event days fall on the hot days that set the peak and take the battery’s energy, so less demand saving is counted this month' }, 'DR events') : null),
        h('td', { class: 'num' }, num(r.peak, r.peak < 100 ? 1 : 0)),
        h('td', { class: 'num' }, num(r.achievable, r.peak < 100 ? 1 : 0)),
        h('td', { class: 'num' }, r.noCharge ? h('span', { class: 'muted' }, '—') : num(r.reduction, 1)),
        h('td', { class: 'num' }, r.noCharge ? h('span', { class: 'muted' }, 'no demand charge') : h('b', {}, usd(r.savings))));
    });
    table = h('table', { class: 'pm-table' },
      h('thead', {}, h('tr', {}, ['Month', 'Peak (kW)', 'Battery holds peak to (kW)', 'Reduction counted (kW)', 'Savings'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
      h('tbody', {}, body),
      h('tfoot', {}, h('tr', {}, h('td', {}, h('b', {}, 'Year')), h('td', {}), h('td', { class: 'num small muted' }, `avg cut ${Math.round(dm.depth.pct * 100)}%`), h('td', {}), h('td', { class: 'num' }, h('b', {}, usd(dm.total))))));
    notes = [h('p', { class: 'small ink2' }, `“Battery holds peak to” is the lowest peak the battery holds on every day of the month (${basis}). Savings are the selected rate’s demand charges on the reduction counted: that cut × ${a.assumptions.shave_capture} for forecasting misses, less in months with demand-response event days. Switch to `, h('b', {}, 'Customer bills'), ' to value each month from its bill instead.')];
  }
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Savings by month'), h('span', { class: 'small muted' }, `${usd(dm.total)}/yr · ${billMode ? 'customer bills' : 'tariff rates'} · click a month to see its dispatch`)),
    chart,
    h('div', { class: 'table-wrap', style: { marginTop: '6px' } }, table),
    ...notes,
  );
}

/** The daily dispatch and the dispatch settings, folded under one line each (open state kept across renders). */
function fold(ctx, which) {
  const { ui, sec, site } = ctx;
  const key = which === 'dispatch' ? 'openDispatch' : 'openSettings';
  const title = which === 'dispatch' ? 'How the battery runs — daily dispatch' : 'Dispatch settings';
  const sub = which === 'dispatch' ? `${MON[(ui.month || sec.D.defaultMonth) - 1]} · dispatch chart, state of charge, every interval` : settingsSummary(site);
  return h('details', { class: 'fold', open: ui[key] ? true : null, ontoggle: (e) => { ui[key] = e.target.open; } },
    h('summary', {}, h('span', { class: 'fold-title' }, title), h('span', { class: 'small muted' }, sub)),
    h('div', { class: 'fold-body' }, ...(which === 'dispatch' ? sec.dispatch : sec.settings)),
  );
}
