// Library: browse programs, tariffs, site constraints, utilities and market prices with sources & confidence.
import { h, badge, confBadge, sourcesList, num, sevIcon } from '../ui.js';

const TABS = [
  ['programs', 'Programs & incentives'],
  ['tariffs', 'Tariffs'],
  ['constraints', 'Site limits & codes'],
  ['utilities', 'Utilities & interconnection'],
  ['market', 'Market prices & assumptions'],
];

const CATEGORY_LABEL = {
  demand_response: 'Demand response',
  upfront_incentive: 'Upfront incentive',
  performance_incentive: 'Performance incentive',
  capacity_tag: 'Capacity tag',
  wholesale_market: 'Wholesale market',
  tax: 'Tax',
  tariff_option: 'Tariff option',
  financing: 'Financing',
  resilience: 'Resilience',
};

export function renderLibrary(root, data, params) {
  const state = {
    tab: params.get('tab') || 'programs',
    market: params.get('market') || 'all',
    category: 'all',
    status: 'all',
    q: '',
  };
  const host = h('div', {});
  root.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Programs, tariffs & site limits'), h('p', {}, 'The research database behind the screener. Every entry shows its confidence, last-verified date and sources. Edit the JSON files in data/ to update it (see Methodology).'))),
    host,
  );

  const allPrograms = () => [
    ...Object.values(data.jurisdictions).flatMap((j) => (j.programs || []).map((p) => ({ ...p, _market: j.code }))),
    ...(data.global.programs || []).map((p) => ({ ...p, _market: 'FEDERAL' })),
  ];

  function filters(extra = []) {
    const markets = [['all', 'All markets'], ...data.manifest.jurisdictions.map((j) => [j.code, j.name]), ['FEDERAL', 'Federal / model codes']];
    return h('div', { class: 'filters' },
      h('select', { 'aria-label': 'Market', onchange: (e) => { state.market = e.target.value; draw(); } }, markets.map(([v, l]) => h('option', { value: v, selected: state.market === v }, l))),
      extra,
      h('input', { type: 'search', placeholder: 'Search…', value: state.q, 'aria-label': 'Search', oninput: (e) => { state.q = e.target.value; drawBody(); } }),
    );
  }

  let body = h('div', {});
  function draw() {
    const tabs = h('div', { class: 'tabs-inline', role: 'tablist' }, TABS.map(([id, l]) => h('button', { role: 'tab', 'aria-selected': state.tab === id ? 'true' : 'false', onclick: () => { state.tab = id; draw(); } }, l)));
    let extra = [];
    if (state.tab === 'programs') {
      const cats = [...new Set(allPrograms().map((p) => p.category))];
      extra = [
        h('select', { 'aria-label': 'Category', onchange: (e) => { state.category = e.target.value; drawBody(); } }, [['all', 'All categories'], ...cats.map((c) => [c, CATEGORY_LABEL[c] || c])].map(([v, l]) => h('option', { value: v, selected: state.category === v }, l))),
        h('select', { 'aria-label': 'Status', onchange: (e) => { state.status = e.target.value; drawBody(); } }, [['all', 'Any status'], ['open', 'Open'], ['waitlist', 'Waitlist'], ['pending_launch', 'Pending launch'], ['pilot', 'Pilot'], ['paused', 'Paused'], ['closed', 'Closed']].map(([v, l]) => h('option', { value: v, selected: state.status === v }, l))),
      ];
    }
    body = h('div', {});
    host.replaceChildren(tabs, filters(extra), body);
    drawBody();
  }

  const match = (obj) => !state.q || JSON.stringify(obj).toLowerCase().includes(state.q.toLowerCase());
  const inMarket = (code) => state.market === 'all' || state.market === code;

  function drawBody() {
    if (state.tab === 'programs') {
      const list = allPrograms().filter((p) => inMarket(p._market) && (state.category === 'all' || p.category === state.category) && (state.status === 'all' || p.status === state.status) && match(p));
      body.replaceChildren(list.length ? h('div', { class: 'lib-grid' }, list.map(programCard)) : empty());
    } else if (state.tab === 'tariffs') {
      const list = Object.values(data.jurisdictions).flatMap((j) => (j.tariffs || []).map((t) => ({ ...t, _market: j.code, _util: j.utilities.find((u) => u.id === t.utility_id)?.name }))).filter((t) => inMarket(t._market) && match(t));
      body.replaceChildren(list.length ? h('div', { class: 'lib-grid' }, list.map(tariffCard)) : empty());
    } else if (state.tab === 'constraints') {
      const list = [
        ...Object.values(data.jurisdictions).flatMap((j) => (j.site_constraints || []).map((c) => ({ ...c, _market: j.code }))),
        ...(data.global.site_constraints || []).map((c) => ({ ...c, _market: 'FEDERAL' })),
      ].filter((c) => inMarket(c._market) && match(c));
      body.replaceChildren(list.length ? h('div', { class: 'lib-grid' }, list.map(constraintCard)) : empty());
    } else if (state.tab === 'utilities') {
      const list = Object.values(data.jurisdictions).flatMap((j) => (j.utilities || []).map((u) => ({ ...u, _market: j.code }))).filter((u) => inMarket(u._market) && match(u));
      body.replaceChildren(list.length ? h('div', { class: 'lib-grid' }, list.map(utilityCard)) : empty());
    } else {
      const list = [
        ...Object.values(data.jurisdictions).flatMap((j) => (j.market_prices || []).map((m) => ({ ...m, _market: j.code }))),
        ...(data.global.market_prices || []).map((m) => ({ ...m, _market: 'FEDERAL' })),
      ].filter((m) => inMarket(m._market) && match(m));
      body.replaceChildren(
        h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Market', 'Item', 'Value', 'Period', 'Confidence', 'Notes / sources'].map((t) => h('th', {}, t)))),
          h('tbody', {}, list.map((m) => h('tr', {},
            h('td', {}, m._market),
            h('td', {}, m.label),
            h('td', { class: 'num' }, m.value != null ? `${num(m.value, 3)} ${m.unit || ''}` : h('span', { class: 'muted' }, 'n/a')),
            h('td', { class: 'small' }, m.period || ''),
            h('td', {}, confBadge(m.confidence)),
            h('td', { class: 'small ink2' }, m.notes || '', sourcesList(m.sources)),
          ))),
        ))),
      );
    }
  }
  draw();
}

const empty = () => h('div', { class: 'card empty' }, 'Nothing matches these filters.');

function programCard(p) {
  const v = p.valuation || {};
  const e = p.eligibility || {};
  const d = p.dispatch || {};
  const size = [e.min_kw != null && `≥ ${num(e.min_kw)} kW`, e.max_kw != null && `≤ ${num(e.max_kw)} kW`, e.min_kwh != null && `≥ ${num(e.min_kwh)} kWh`, e.max_kwh != null && `≤ ${num(e.max_kwh)} kWh`, e.min_duration_hr != null && `≥ ${e.min_duration_hr} h`].filter(Boolean).join(', ');
  const reqs = [e.requires_aggregator_or_csp && 'aggregator / CSP', e.requires_export && 'export', e.requires_paired_solar && 'paired solar', e.requires_ul9540 && 'UL 9540'].filter(Boolean).join(', ');
  const rows = [
    ['Market', `${p._market}${p.utility_ids?.length ? ' · ' + p.utility_ids.join(', ') : ''}`],
    ['Category', CATEGORY_LABEL[p.category] || p.category],
    ['Size thresholds', size || 'none stated'],
    ['Requires', reqs || '—'],
    ['Season / window', [d.season, d.window].filter(Boolean).join(' · ') || '—'],
    ['Events', [d.event_duration_hr && `${d.event_duration_hr} h each`, d.typical_events_per_year && `~${d.typical_events_per_year}/yr typical`, d.max_events_per_year && `max ${d.max_events_per_year}`, d.notice && `${d.notice} notice`].filter(Boolean).join(', ') || '—'],
    ['Measurement', d.baseline_or_mv || '—'],
    ['Term', v.term_years ? `${v.term_years} yr` : '—'],
    ['Payment basis', v.kw_basis || v.notes || '—'],
    ['Stacking', [p.stacking?.conflicts_with?.length && `Conflicts: ${p.stacking.conflicts_with.join(', ')}`, p.stacking?.notes].filter(Boolean).join(' — ') || '—'],
    ['VPP relevance', p.vpp_relevance || '—'],
  ];
  return h('div', { class: 'prog' },
    h('div', { class: 'head' },
      h('div', {}, h('h3', {}, p.name), h('div', { class: 'small muted' }, p.administrator || '')),
      h('div', { style: { textAlign: 'right' } }, badge(p.status || 'unknown', p.status), h('div', { class: 'rate' }, v.rate != null ? rateText(v) : h('span', { class: 'muted small' }, v.method === 'text_only' ? 'qualitative' : 'rate n/a'))),
    ),
    p.status_notes ? h('p', { class: 'small ink2', style: { marginTop: '6px' } }, p.status_notes) : null,
    v.tiers?.length ? h('div', { class: 'small' }, h('strong', {}, 'Tiers: '), v.tiers.map((t) => `${t.label}: ${t.rate ?? '?'}${t.conditions ? ` (${t.conditions})` : ''}`).join('; ')) : null,
    h('dl', { class: 'kv' }, rows.map(([k, val]) => [h('dt', {}, k), h('dd', {}, val)])),
    h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } }, confBadge(p.confidence), p.last_verified ? h('span', { class: 'small muted' }, `verified ${p.last_verified}`) : null),
    p.verification_notes ? h('p', { class: 'small muted', style: { marginTop: '6px' } }, p.verification_notes) : null,
    sourcesList(p.sources),
  );
}

function rateText(v) {
  if (v.method === 'pct_of_cost') return `${(v.rate * 100).toFixed(0)}% of cost`;
  return `$${num(v.rate, v.rate < 10 ? 2 : 0)} ${String(v.unit || '').replace(/^\$/, '')}`;
}

function tariffCard(t) {
  return h('div', { class: 'prog' },
    h('div', { class: 'head' }, h('div', {}, h('h3', {}, t.name), h('div', { class: 'small muted' }, `${t._market} · ${t._util || t.utility_id}${t.customer_class ? ' · ' + t.customer_class : ''}`)), h('div', {}, confBadge(t.confidence))),
    h('div', { class: 'small ink2', style: { marginTop: '4px' } }, t.applicability?.text || '', t.applicability?.min_kw != null || t.applicability?.max_kw != null ? ` (${t.applicability.min_kw ?? 0}–${t.applicability.max_kw ?? '∞'} kW)` : ''),
    (t.demand_charges || []).length
      ? h('table', { style: { marginTop: '8px' } }, h('tbody', {}, t.demand_charges.map((d) => h('tr', {}, h('td', { class: 'small' }, d.label, h('div', { class: 'muted' }, [d.basis, d.window ? `${d.window.start}–${d.window.end}h` : d.hours, d.months?.length && d.months.length < 12 ? `months ${d.months.join(',')}` : ''].filter(Boolean).join(' · '))), h('td', { class: 'num' }, d.rate_usd_per_kw_month != null ? `$${d.rate_usd_per_kw_month}` : h('span', { class: 'muted' }, 'n/a'))))))
      : h('p', { class: 'small muted' }, 'No demand charges recorded.'),
    (t.coincident_peak_charges || []).map((c) => h('div', { class: 'small', style: { marginTop: '4px' } }, h('strong', {}, `${c.type}: `), c.est_value_usd_per_kw_year != null ? `$${c.est_value_usd_per_kw_year}/kW-yr` : 'n/a', c.derivation ? h('span', { class: 'muted' }, ` — ${c.derivation}`) : null)),
    t.ratchet ? h('div', { class: 'small', style: { marginTop: '4px' } }, h('strong', {}, 'Ratchet: '), `${t.ratchet.pct != null ? Math.round(t.ratchet.pct * 100) + '%' : ''} ${t.ratchet.applies_to || ''}`) : null,
    t.storage_notes ? h('p', { class: 'small ink2', style: { marginTop: '6px' } }, t.storage_notes) : null,
    h('div', { class: 'small muted', style: { marginTop: '6px' } }, t.effective_date ? `Effective ${t.effective_date}. ` : '', t.verification_notes || ''),
    sourcesList(t.sources),
  );
}

function constraintCard(c) {
  return h('div', { class: 'prog' },
    h('div', { class: 'head' }, h('div', {}, h('h3', {}, c.title), h('div', { class: 'small muted' }, `${c._market} · ${c.topic || ''}${c.applies_to ? ' · ' + c.applies_to : ''}`)), h('div', {}, confBadge(c.confidence))),
    h('p', { class: 'small ink2', style: { marginTop: '6px' } }, c.rule),
    c.threshold?.value != null ? h('div', { class: 'small' }, h('strong', {}, 'Threshold: '), `${c.threshold.comparison || ''} ${num(c.threshold.value)} ${c.threshold.metric || ''} ${c.threshold.scope ? '(' + c.threshold.scope + ')' : ''}`) : null,
    c.impact_on_sizing ? h('p', { class: 'small', style: { marginTop: '4px' } }, h('strong', {}, 'Sizing impact: '), c.impact_on_sizing) : null,
    sourcesList(c.sources),
  );
}

function utilityCard(u) {
  const ix = u.interconnection || {};
  return h('div', { class: 'prog' },
    h('div', { class: 'head' }, h('div', {}, h('h3', {}, u.name), h('div', { class: 'small muted' }, `${u._market} · ${u.iso || ''} ${u.load_zone ? '· ' + u.load_zone : ''} · id: ${u.id}`)), h('div', {}, confBadge(ix.confidence))),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Retail choice'), h('dd', {}, u.retail_choice == null ? '—' : u.retail_choice ? 'Yes' : 'No'),
      h('dt', {}, 'Default supply'), h('dd', {}, u.default_supply_notes || '—'),
      h('dt', {}, 'Network grid'), h('dd', {}, u.network_grid_notes || '—'),
      h('dt', {}, 'Interconnection'), h('dd', {}, ix.rule_name || '—'),
    ),
    (ix.tracks || []).length ? h('table', { style: { marginTop: '8px' } }, h('tbody', {}, ix.tracks.map((t) => h('tr', {}, h('td', { class: 'small' }, h('strong', {}, t.name), h('div', { class: 'muted' }, [t.conditions, t.typical_timeline, t.application_fee].filter(Boolean).join(' · '))), h('td', { class: 'num' }, t.max_kw != null ? `≤ ${num(t.max_kw)} kW` : '—'))))) : null,
    ix.non_export_path ? h('p', { class: 'small ink2', style: { marginTop: '6px' } }, h('strong', {}, 'Non-export path: '), ix.non_export_path) : null,
    ix.storage_specific_notes ? h('p', { class: 'small ink2' }, ix.storage_specific_notes) : null,
    sourcesList([...(ix.sources || []), ...(u.sources || [])]),
  );
}
