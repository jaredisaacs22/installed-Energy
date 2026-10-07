// Portfolio: saved sites ranked side by side, bulk CSV import, combined export.
import { h, usd, num, yrs, sevBadge, storage, toast, badge } from '../ui.js';
import { analyzeSite } from '../engine/index.js';
import { intervalStore } from '../interval-store.js';
import { settingsStore } from '../app.js';
import { normalizeSite, defaultSite } from './screener.js';
import { xlsx, toCsv, zip, download, parseCsv, configRows, streamRows, limitRows, programRows, panelRows, monthlyRows, README_ROWS } from '../export.js';

const KEY = 'atlas.portfolio';

export function addToPortfolio(site, data) {
  const list = storage.get(KEY, []);
  const copy = JSON.parse(JSON.stringify(site));
  copy.id = copy.id || `site-${Date.now().toString(36)}`;
  const i = list.findIndex((s) => s.id === copy.id);
  if (i >= 0) list[i] = copy;
  else list.push(copy);
  storage.set(KEY, list);
}

/** CSV template columns → site fields (types). */
export const TEMPLATE_COLUMNS = [
  ['id', 'text', 'Unique site ID'],
  ['name', 'text', 'Site name'],
  ['jurisdiction', 'text', 'MA | CT | NY-NYC | IL | TX | CA | HI'],
  ['utility_id', 'text', 'See Programs & tariffs → Utilities for ids'],
  ['tariff_id', 'text', 'Optional; suggested from peak kW if blank'],
  ['building_type', 'text', 'office | retail | grocery | warehouse | restaurant | manufacturing | school | hotel | cold_storage'],
  ['peak_kw', 'number', 'Annual peak demand'],
  ['annual_kwh', 'number', 'Annual usage'],
  ['min_load_kw', 'number', 'Optional'],
  ['energy_price', 'number', 'All-in $/kWh (optional)'],
  ['service_voltage', 'number', '208 | 240 | 480'],
  ['phases', 'number', '3 or 1'],
  ['service_amps', 'number', ''],
  ['main_breaker_amps', 'number', ''],
  ['busbar_amps', 'number', ''],
  ['network_secondary', 'text', 'yes | no | unknown'],
  ['install_location', 'text', 'outdoor_ground | rooftop | indoor | parking_garage'],
  ['available_area_sqft', 'number', 'Optional'],
  ['setback_ok', 'text', 'yes | no | unknown'],
  ['flood_zone', 'text', 'yes | no | unknown'],
  ['supply_contract', 'text', 'unknown | passthrough | index | fixed_all_in | default_service'],
  ['has_solar', 'bool', 'true/false'],
  ['export_allowed', 'bool', 'true/false'],
  ['disadvantaged_community', 'bool', 'true/false'],
  ['property_owner', 'bool', 'true/false (customer owns building / pays property tax)'],
  ['demand_rate_usd_per_kw', 'number', 'Optional: the customer’s demand charges per billed kW (from the bills); values demand from the bills instead of the tariff'],
  ['ratchet_pct', 'number', 'Optional: billing floor (ratchet) % for the bill-based savings; blank = the rate’s own'],
];
const BILL_COLUMNS = new Set(['demand_rate_usd_per_kw', 'ratchet_pct']);

export function siteFromCsvRow(row, data) {
  const site = defaultSite(data);
  for (const [col, type] of TEMPLATE_COLUMNS) {
    const v = row[col];
    if (v == null || v === '' || BILL_COLUMNS.has(col)) continue;
    site[col] = type === 'number' ? Number(v) : type === 'bool' ? /^(true|yes|1|y)$/i.test(v) : v;
  }
  if (!row.tariff_id) site.tariff_id = null;
  const rate = Number(row.demand_rate_usd_per_kw);
  if (row.demand_rate_usd_per_kw && rate > 0) site.bills = { use: true, rate_usd_per_kw: rate, ...(row.ratchet_pct !== '' && row.ratchet_pct != null && Number.isFinite(Number(row.ratchet_pct)) ? { ratchet_pct: Number(row.ratchet_pct) } : {}) };
  return normalizeSite(site, data);
}

export function renderPortfolio(root, data) {
  const settings = settingsStore.get(data);
  let sites = storage.get(KEY, []);
  let analyses = [];
  let rankBy = storage.get('atlas.portfolio.rank', 'savings');
  const host = h('div', {});
  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', style: { display: 'none' }, onchange: async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const rows = parseCsv(await f.text());
    let added = 0;
    const errors = [];
    rows.forEach((row, i) => {
      try {
        if (!data.jurisdictions[row.jurisdiction]) throw new Error(`unknown jurisdiction "${row.jurisdiction}"`);
        addToPortfolio(siteFromCsvRow(row, data), data);
        added++;
      } catch (err) {
        errors.push(`Row ${i + 2}: ${err.message}`);
      }
    });
    toast(`Imported ${added} site${added === 1 ? '' : 's'}${errors.length ? `, ${errors.length} skipped` : ''}`);
    if (errors.length) alert(errors.join('\n'));
    sites = storage.get(KEY, []);
    compute();
  } });

  root.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Portfolio'), h('p', {}, 'Rank candidate install locations side by side by what a battery saves on demand charges. Save sites from the screener, or import a CSV of sites for bulk screening. Everything is stored in this browser only.')),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn', href: 'templates/site_import_template.csv', download: 'site_import_template.csv' }, 'Download CSV template'),
        h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Import sites (CSV)'),
        h('button', { class: 'btn primary', onclick: () => exportAll() }, 'Export portfolio (.xlsx)'),
        h('button', { class: 'btn', onclick: () => exportCsv() }, 'Export CSVs (.zip)'),
      ),
    ),
    fileInput,
    host,
  );

  function compute() {
    analyses = sites.map((s) => {
      try {
        return analyzeSite(normalizeSite(s, data), data, settings, { interval: intervalStore.intervalFor(s.interval_id) });
      } catch (err) {
        return { site: s, error: String(err) };
      }
    });
    draw();
  }

  const RANKS = [
    ['savings', 'Demand savings', (a) => a.recommended?.demand.total ?? 0],
    ['density', 'Savings per kWh', (a) => (a.recommended ? a.recommended.demand.total / Math.max(1, a.recommended.config.kwh) : 0)],
    ['cut', 'Peak cut %', (a) => a.recommended?.peakCut.pct ?? 0],
    ['score', 'Site score', (a) => a.score.score],
  ];

  function draw() {
    if (!sites.length) {
      host.replaceChildren(h('div', { class: 'card empty' }, 'No sites yet. In the Site screener click “Save to portfolio” (Export tab), or import a CSV.'));
      return;
    }
    const metric = (RANKS.find(([k]) => k === rankBy) || RANKS[0])[2];
    // Sites whose demand savings are not priced (tariff rates missing, no bills) rank after the rest.
    const unpriced = (a) => a.recommended?.demand.mode !== 'bills' && (a.missing || []).length > 0;
    const ok = analyses.filter((a) => !a.error).sort((a, b) => Number(unpriced(a)) - Number(unpriced(b)) || metric(b) - metric(a));
    const totalKw = ok.reduce((n, a) => n + (a.recommended?.config.kw || 0), 0);
    const totalKwh = ok.reduce((n, a) => n + (a.recommended?.config.kwh || 0), 0);
    const totalDemand = ok.reduce((n, a) => n + (a.recommended?.demand.total || 0), 0);
    const costs = ok.some((a) => a.costsKnown);
    const heads = ['Rank', 'Site', 'Market / utility', 'Peak kW', 'Suggested system', 'Peak cut', 'Demand savings', 'Other value', ...(costs ? ['Payback'] : []), 'Score', 'Site check', ''];
    const numCols = new Set(['Peak kW', 'Peak cut', 'Demand savings', 'Other value', 'Payback']);
    host.replaceChildren(
      h('div', { class: 'kpis', style: { gridTemplateColumns: 'repeat(4, minmax(0,1fr))', marginBottom: '14px' } },
        h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Sites'), h('div', { class: 'value' }, num(ok.length))),
        h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Batteries (suggested)'), h('div', { class: 'value' }, `${num(totalKw / 1000, 2)} MW`), h('div', { class: 'sub' }, `${num(totalKwh / 1000, 2)} MWh — your VPP capacity`)),
        h('div', { class: 'kpi highlight' }, h('div', { class: 'label' }, 'Demand savings'), h('div', { class: 'value' }, `${usd(totalDemand, { compact: true })}/yr`), h('div', { class: 'sub' }, 'all sites, suggested systems')),
        h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Markets'), h('div', { class: 'value' }, [...new Set(ok.map((a) => a.site.jurisdiction))].join(', '))),
      ),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Sites'),
          h('div', { class: 'rank-by' }, h('span', { class: 'small muted' }, 'Rank by '), h('div', { class: 'seg' }, RANKS.map(([k, l]) => h('button', { type: 'button', 'aria-pressed': rankBy === k ? 'true' : 'false', onclick: () => { rankBy = k; storage.set('atlas.portfolio.rank', k); draw(); } }, l))))),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, heads.map((t) => h('th', { class: numCols.has(t) ? 'num' : '' }, t)))),
          h('tbody', {},
            ok.map((a, i) => {
              const r = a.recommended;
              const util = a.jurisdiction.utilities.find((u) => u.id === a.site.utility_id);
              const other = r ? r.totals.annual_base - r.streams.filter((x) => x.category === 'demand_charge' && x.scenario === 'base').reduce((n, x) => n + x.annual_usd, 0) : null;
              return h('tr', {},
                h('td', {}, i + 1),
                h('td', {}, h('strong', {}, a.site.name || a.site.id), /^site-/.test(a.site.id || '') ? null : h('div', { class: 'small muted' }, a.site.id)),
                h('td', { class: 'small' }, a.site.jurisdiction, ' · ', util?.name || a.site.utility_id),
                h('td', { class: 'num' }, num(a.site.peak_kw)),
                h('td', { class: 'small' }, r?.config.label || '—'),
                h('td', { class: 'num' }, r ? `${num(r.peakCut.kw, r.peakCut.kw < 100 ? 1 : 0)} kW · ${Math.round(r.peakCut.pct * 100)}%` : '—'),
                h('td', { class: 'num' }, h('strong', {}, usd(r?.demand.total)), h('div', { class: 'small muted' }, r?.demand.mode === 'bills' ? 'bills' : unpriced(a) ? 'rates missing' : 'tariff')),
                h('td', { class: 'num' }, usd(other, { compact: true })),
                ...(costs ? [h('td', { class: 'num' }, a.costsKnown ? yrs(r?.finance.base.simplePayback) : '—')] : []),
                h('td', {}, badge(`${a.score.score} · ${a.score.grade}`, a.score.score >= 65 ? 'ok' : a.score.score >= 50 ? 'info' : 'caution')),
                h('td', {}, r ? sevBadge(r.constraints.status) : '—'),
                h('td', {}, h('div', { class: 'btn-row' },
                  h('a', { class: 'btn small', href: `#/screener?s=${btoa(unescape(encodeURIComponent(JSON.stringify(a.site))))}` }, 'Open'),
                  h('button', { class: 'btn small', onclick: () => { sites = sites.filter((s) => s.id !== a.site.id); storage.set(KEY, sites); compute(); } }, 'Remove'),
                )),
              );
            }),
            analyses.filter((a) => a.error).map((a) => h('tr', {}, h('td', {}, '!'), h('td', { colspan: heads.length - 1, class: 'small' }, `${a.site.name || a.site.id}: ${a.error}`))),
          ),
        )),
        h('p', { class: 'small muted', style: { marginTop: '8px' } }, 'Demand savings: the suggested system’s demand-charge savings, from the customer’s bills where entered, else the tariff. Other value: demand response, peak tags and energy shifting (base case). Score blends value, certainty and site feasibility.'),
      ),
    );
  }

  function portfolioSheets() {
    const ok = analyses.filter((a) => !a.error);
    const summary = ok.map((a) => ({
      site_id: a.site.id,
      site_name: a.site.name,
      market: a.site.jurisdiction,
      utility_id: a.site.utility_id,
      tariff_id: a.site.tariff_id,
      peak_kw: a.site.peak_kw,
      annual_kwh: a.site.annual_kwh,
      score: a.score.score,
      grade: a.score.grade,
      data_incomplete: a.score.incomplete ? 'yes' : '',
      missing_rates: (a.missing || []).join(' | '),
      recommended_config: a.recommended?.config.id,
      rec_kw: a.recommended?.config.kw,
      rec_kwh: a.recommended?.config.kwh,
      peak_cut_kw: a.recommended?.peakCut.kw,
      peak_cut_pct: a.recommended ? Math.round(a.recommended.peakCut.pct * 1000) / 10 : null,
      demand_savings_usd: a.recommended?.demand.total,
      demand_savings_basis: a.recommended?.demand.mode,
      annual_value_base_usd: a.recommended?.totals.annual_base,
      upfront_base_usd: a.recommended?.totals.upfront_base,
      payback_yr: a.costsKnown ? a.recommended?.finance.base.simplePayback : null,
      npv_usd: a.costsKnown ? a.recommended?.finance.base.npv : null,
      constraint_status: a.recommended?.constraints.status,
    }));
    return [
      { name: 'README', rows: README_ROWS },
      { name: 'PortfolioSummary', rows: summary },
      { name: 'DemandByMonth', rows: ok.flatMap((a) => monthlyRows(a)) },
      { name: 'Configs', rows: ok.flatMap(configRows) },
      { name: 'ValueStreams', rows: ok.flatMap(streamRows) },
      { name: 'Programs', rows: ok.flatMap(programRows) },
      { name: 'SiteLimits', rows: ok.flatMap(limitRows) },
      { name: 'Panel', rows: ok.flatMap(panelRows) },
    ];
  }
  function exportAll() {
    if (!analyses.length) return toast('Portfolio is empty');
    download('bess_portfolio.xlsx', xlsx(portfolioSheets()), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }
  function exportCsv() {
    if (!analyses.length) return toast('Portfolio is empty');
    download('bess_portfolio_csv.zip', zip(portfolioSheets().map((s) => ({ name: `${s.name}.csv`, data: toCsv(s.rows) }))), 'application/zip');
  }

  compute();
}

