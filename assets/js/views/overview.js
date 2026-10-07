// Overview: markets at a glance, product fit by event duration, how to use the tool.
import { h, num, badge } from '../ui.js';
import { resolveAssumptions } from '../engine/index.js';

const isMonthlyDemand = (d) => typeof d.rate_usd_per_kw_month === 'number' && d.rate_usd_per_kw_month > 0 && !['daily', 'coincident', 'contract'].includes(d.basis);
const countsForCoverage = (d) => !['contract', 'coincident'].includes(d.basis);

/** Rough annual $/kW of a program's headline rate, for ranking only (not shown as a value). */
function annualPerKw(p) {
  const v = p.valuation || {};
  if (typeof v.rate !== 'number') return 0;
  switch (v.method) {
    case 'per_kw_season':
      return v.rate * (v.seasons_per_year || 1);
    case 'per_kw_month':
      return v.rate * (v.months_per_year || 12);
    case 'per_kw_year':
      return v.rate;
    default:
      return 0;
  }
}

export function rateLabel(v) {
  if (!v || typeof v.rate !== 'number') return 'rate n/a';
  if (v.method === 'pct_of_cost') return `${Math.round(v.rate * 100)}% of cost`;
  const unit = String(v.unit || '').replace(/^\$/, '');
  return `$${num(v.rate, v.rate < 10 ? 2 : 0)} ${unit}`.trim();
}

export function marketStats(j) {
  const charges = (j.tariffs || []).flatMap((t) => t.demand_charges || []);
  const covered = charges.filter(countsForCoverage);
  const priced = covered.filter((d) => typeof d.rate_usd_per_kw_month === 'number');
  // Total July demand charge per tariff (sum of priced monthly components active in July), so ranges
  // compare whole tariffs rather than individual adders.
  const julyTotals = (j.tariffs || [])
    .map((t) => (t.demand_charges || []).filter((d) => isMonthlyDemand(d) && (!d.months?.length || d.months.includes(7))).reduce((n, d) => n + d.rate_usd_per_kw_month, 0))
    .filter((x) => x > 0);
  const cps = (j.tariffs || []).flatMap((t) => t.coincident_peak_charges || []).filter((c) => typeof c.est_value_usd_per_kw_year === 'number' && c.est_value_usd_per_kw_year > 0 && !c.optional_election);
  const tags = cps.map((c) => c.est_value_usd_per_kw_year);
  const tagTypes = [...new Set(cps.map((c) => c.type))];
  const live = (j.programs || []).filter((p) => ['open', 'pilot'].includes(p.status) && p.valuation?.method !== 'text_only');
  const confRank = { high: 0, medium: 1, low: 2 };
  const dispatch = live.filter((p) => annualPerKw(p) > 0).sort((a, b) => (confRank[a.confidence] ?? 1) - (confRank[b.confidence] ?? 1) || annualPerKw(b) - annualPerKw(a));
  const upfront = live.filter((p) => ['upfront_per_kwh', 'upfront_per_kw', 'pct_of_cost'].includes(p.valuation?.method) && typeof p.valuation?.rate === 'number');
  const watch = (j.panel_notes || []).filter((n) => n.severity === 'critical').concat((j.panel_notes || []).filter((n) => n.severity === 'caution'));
  return {
    coverage: covered.length ? priced.length / covered.length : 1,
    pricedCount: priced.length,
    coveredCount: covered.length,
    demandRange: julyTotals.length ? [Math.min(...julyTotals), Math.max(...julyTotals)] : null,
    tagRange: tags.length ? [Math.min(...tags), Math.max(...tags)] : null,
    tagTypes,
    dispatch,
    upfront,
    watch,
    openCount: live.length,
  };
}

const TAG_NAMES = { icap: 'ICAP', capacity_tag: 'ICAP', plc: 'PLC', nspl: 'NSPL', '4cp': '4CP', transmission_tag: 'transmission' };

export function renderOverview(root, data) {
  const A = resolveAssumptions(data);
  const markets = data.manifest.jurisdictions.map((m) => data.jurisdictions[m.code]);
  const totals = markets.reduce(
    (acc, j) => {
      const s = marketStats(j);
      acc.programs += (j.programs || []).length;
      acc.tariffs += (j.tariffs || []).length;
      acc.priced += s.pricedCount;
      acc.covered += s.coveredCount;
      return acc;
    },
    { programs: 0, tariffs: 0, priced: 0, covered: 0 },
  );
  const coveragePct = totals.covered ? Math.round((100 * totals.priced) / totals.covered) : 100;

  root.append(
    h('section', { class: 'hero' },
      h('div', { class: 'hero-copy' },
        h('div', { class: 'eyebrow' }, 'Behind-the-meter C&I storage'),
        h('h1', {}, 'Find the sites where batteries pay, and what limits them'),
        h('p', {}, `Screen commercial, industrial and retail sites across ${markets.length} markets. Every battery configuration is valued against current tariffs, peak tags and programs, checked against electrical, fire-code and interconnection limits, and reviewed by the expert panel.`),
        h('div', { class: 'btn-row' },
          h('a', { class: 'btn gold', href: '#/screener' }, 'Screen a site →'),
          h('a', { class: 'btn', href: '#/portfolio' }, 'Rank a portfolio'),
          h('a', { class: 'btn', href: '#/health' }, 'Data health'),
        ),
      ),
      h('div', { class: 'hero-side' },
        h('div', { class: 'hero-stats', role: 'group', 'aria-label': 'What the database holds' },
          [[totals.programs, 'programs'], [totals.tariffs, 'tariffs'], [`${coveragePct}%`, 'rates verified']].map(([v, l]) => h('div', { class: 'hero-stat' }, h('b', {}, String(v)), h('span', {}, l)))),
        h('div', { class: 'hero-ver' }, `Data ${data.manifest.data_version} · updated ${data.manifest.updated}`),
      ),
    ),
    h('div', { class: 'page-head' }, h('div', {}, h('div', { class: 'eyebrow' }, 'Markets at a glance'), h('h2', { style: { margin: 0 } }, 'Where the value is, and how complete the data is'))),
    h('div', { class: 'market-grid' }, markets.map((j) => marketCard(j))),
    productFit(data, A),
    h('div', { class: 'card', style: { marginTop: '16px' } },
      h('div', { class: 'eyebrow' }, 'How to use it'),
      h('div', { class: 'cols-3', style: { gridTemplateColumns: 'repeat(4, minmax(0,1fr))' } },
        step(1, 'Screen a site', 'Market, utility, rate, peak kW and annual kWh are enough to start. Add electrical service details to check size limits.'),
        step(2, 'Clear the accuracy checklist', 'Enter missing rates from the customer bill, your installed cost, the supply contract, and interval-data shave kW.'),
        step(3, 'Export to your model', 'Download Excel/CSV. Use the TariffParams sheet to price the interval-data dispatch.'),
        step(4, 'Rank the portfolio', 'Save or import sites to compare scores and build toward a VPP.'),
      ),
    ),
  );
}

function step(n, title, text) {
  return h('div', {}, h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' } }, h('span', { class: 'step', style: { width: '24px', height: '24px', borderRadius: '50%', background: 'var(--gold)', color: 'var(--green-deep)', display: 'inline-grid', placeItems: 'center', fontWeight: 800, fontSize: '12px' } }, n), h('strong', {}, title)), h('div', { class: 'small ink2' }, text));
}

function marketCard(j) {
  const s = marketStats(j);
  const pct = Math.round(s.coverage * 100);
  const range = (r, unit) => (r ? (r[0] === r[1] ? `$${num(r[0], 2)}${unit}` : `$${num(r[0], r[0] < 10 ? 2 : 0)}–${num(r[1], r[1] < 10 ? 2 : 0)}${unit}`) : '—');
  return h('div', { class: 'market' },
    h('div', { class: 'top' },
      h('div', {}, h('div', { class: 'code' }, j.code), h('h3', { style: { margin: 0 } }, j.name), h('div', { class: 'small muted' }, [...new Set((j.utilities || []).map((u) => u.iso).filter(Boolean))].join(' · '))),
      h('div', { style: { minWidth: '120px' } }, h('div', { class: 'small muted', style: { textAlign: 'right' } }, `Rate coverage ${pct}%`), h('div', { class: 'meter', title: `${s.pricedCount} of ${s.coveredCount} demand-charge elements have a verified rate` }, h('span', { style: { width: `${pct}%`, background: pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--gold-dark)' : 'var(--critical)' } }))),
    ),
    h('div', { class: 'stat-row' },
      h('div', { class: 'stat', title: 'Sum of priced monthly demand components per tariff in July (excludes daily Option S charges)' }, h('div', { class: 'k' }, 'Demand charges'), h('div', { class: 'v' }, range(s.demandRange, '')), h('div', { class: 'small muted' }, '$/kW-mo, July total')),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, `Peak tags${s.tagTypes.length ? ' (' + s.tagTypes.map((t) => TAG_NAMES[t] || t).join(', ') + ')' : ''}`), h('div', { class: 'v' }, range(s.tagRange, '')), h('div', { class: 'small muted' }, '$/kW-year')),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Open programs'), h('div', { class: 'v' }, num(s.openCount)), h('div', { class: 'small muted' }, 'open or pilot')),
    ),
    s.dispatch.length
      ? h('div', {}, h('h4', {}, 'Top dispatch value'), h('ul', {}, s.dispatch.slice(0, 3).map((p) => h('li', {}, h('strong', {}, shortName(p.name)), ` — ${rateLabel(p.valuation)}${p.valuation?.duration_basis_hr ? `, ${p.valuation.duration_basis_hr} h basis` : ''} `, p.requires_confirmation ? badge('confirm eligibility', 'caution') : null, p.confidence === 'low' ? badge('low confidence', 'low') : null))))
      : h('div', { class: 'small muted' }, 'No priced dispatch programs open.'),
    s.upfront.length ? h('div', {}, h('h4', {}, 'Upfront / tax'), h('ul', {}, s.upfront.slice(0, 3).map((p) => h('li', {}, h('strong', {}, shortName(p.name)), ` — ${rateLabel(p.valuation)}`)))) : null,
    s.watch.length ? h('div', {}, h('h4', {}, 'Watch-outs'), h('ul', {}, s.watch.slice(0, 2).map((n) => h('li', {}, n.topic)))) : null,
    h('div', { class: 'btn-row', style: { marginTop: 'auto' } },
      h('a', { class: 'btn primary small', href: `#/screener?market=${encodeURIComponent(j.code)}` }, `Screen a ${j.code} site`),
      h('a', { class: 'btn small', href: `#/library?market=${encodeURIComponent(j.code)}` }, 'Programs & tariffs'),
    ),
  );
}

const shortName = (n) =>
  String(n)
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s+—.*$/, '')
    .replace(/\s+,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/[,\s-]+$/, '')
    .trim();

/** Credited kW per unit for the event durations used by open programs. */
function productFit(data, A) {
  const durations = new Map();
  for (const j of Object.values(data.jurisdictions)) {
    for (const p of j.programs || []) {
      const d = p.valuation?.duration_basis_hr;
      if (!['open', 'pilot'].includes(p.status) || !(d > 0) || typeof p.valuation?.rate !== 'number' || p.valuation.method === 'text_only' || p.valuation.method?.startsWith('upfront')) continue;
      if (!durations.has(d)) durations.set(d, []);
      durations.get(d).push(`${j.code}: ${shortName(p.name)}`);
    }
  }
  const cols = [...durations.keys()].sort((a, b) => a - b);
  if (!cols.length) return null;
  return h('div', { class: 'card accent', style: { marginTop: '16px' } },
    h('div', { class: 'card-head' },
      h('div', {}, h('div', { class: 'eyebrow' }, 'Product fit'), h('h2', { style: { margin: 0 } }, 'Credited kW per unit by event duration')),
      h('span', { class: 'small muted' }, 'Credited kW = min(kW, usable kWh ÷ hours), using each unit’s usable kWh'),
    ),
    h('p', { class: 'small ink2' }, 'Programs pay on the kW a battery can hold for the full event. A 2-hour unit earns well below nameplate in 3–4 hour programs. Hover a column heading to see which programs use that duration.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Product'), h('th', { class: 'num' }, 'Duration'), cols.map((d) => h('th', { class: 'num', title: durations.get(d).join('\n') }, `${d} h events`)))),
      h('tbody', {}, data.products.map((p) => h('tr', {},
        h('td', {}, h('strong', {}, p.label), h('div', { class: 'small muted' }, `${num(usableOf(p, A), 1)} kWh deliverable`)),
        h('td', { class: 'num' }, `${num(usableOf(p, A) / p.kw, 1)} h`),
        cols.map((d) => {
          const kw = Math.min(p.kw, usableOf(p, A) / d);
          const pct = kw / p.kw;
          return h('td', { class: 'num', style: { color: pct >= 0.999 ? 'var(--good-ink)' : pct >= 0.75 ? 'var(--ink)' : 'var(--critical-ink)', fontWeight: pct >= 0.999 ? 700 : 500 } }, `${num(kw, 0)} kW `, h('span', { class: 'muted small' }, `(${Math.round(pct * 100)}%)`));
        }),
      ))),
    )),
    h('div', { class: 'small muted', style: { marginTop: '8px' } }, cols.map((d) => h('div', {}, h('strong', {}, `${d} h: `), durations.get(d).slice(0, 6).join(' · ')))),
  );
}

// AC energy deliverable from full: stored usable kWh × discharge efficiency (workbench convention).
const usableOf = (p, A) => (typeof p.usable_kwh === 'number' ? p.usable_kwh * (p.eff_discharge ?? 1) : p.kwh * A.usable_fraction);
