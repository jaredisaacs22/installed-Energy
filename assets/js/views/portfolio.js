// Portfolio: saved sites ranked side by side, bulk CSV import, combined export.
import { h, usd, num, yrs, sevBadge, storage, toast, badge } from '../ui.js';
import { analyzeSite } from '../engine/index.js';
import { intervalStore } from '../interval-store.js';
import { settingsStore } from '../app.js';
import { normalizeSite, defaultSite } from './screener.js';
import { xlsx, toCsv, zip, download, parseCsv, configRows, streamRows, limitRows, programRows, panelRows, README_ROWS } from '../export.js';

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
];

export function siteFromCsvRow(row, data) {
  const site = defaultSite(data);
  for (const [col, type] of TEMPLATE_COLUMNS) {
    const v = row[col];
    if (v == null || v === '') continue;
    site[col] = type === 'number' ? Number(v) : type === 'bool' ? /^(true|yes|1|y)$/i.test(v) : v;
  }
  if (!row.tariff_id) site.tariff_id = null;
  return normalizeSite(site, data);
}

export function renderPortfolio(root, data) {
  const settings = settingsStore.get(data);
  let sites = storage.get(KEY, []);
  let analyses = [];
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
      h('div', {}, h('h1', {}, 'Portfolio'), h('p', {}, 'Rank candidate sites side by side. Save sites from the screener, or import a CSV of sites for bulk screening. Everything is stored in this browser only.')),
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

  function draw() {
    if (!sites.length) {
      host.replaceChildren(h('div', { class: 'card empty' }, 'No sites yet. In the Site screener click “Save to portfolio”, or import a CSV.'));
      return;
    }
    // Complete analyses rank first; sites with missing tariff rates are listed after them.
    const ok = analyses.filter((a) => !a.error).sort((a, b) => Number(a.score.incomplete) - Number(b.score.incomplete) || b.score.score - a.score.score);
    const totalKw = ok.reduce((n, a) => n + (a.recommended?.config.kw || 0), 0);
    const totalKwh = ok.reduce((n, a) => n + (a.recommended?.config.kwh || 0), 0);
    const totalVal = ok.reduce((n, a) => n + (a.recommended?.totals.annual_base || 0), 0);
    host.replaceChildren(
      h('div', { class: 'kpis', style: { gridTemplateColumns: 'repeat(4, minmax(0,1fr))', marginBottom: '14px' } },
        h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Sites'), h('div', { class: 'value' }, num(ok.length))),
        h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Portfolio battery (recommended)'), h('div', { class: 'value' }, `${num(totalKw / 1000, 2)} MW`), h('div', { class: 'sub' }, `${num(totalKwh / 1000, 2)} MWh — your VPP capacity`)),
        h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Annual value (base)'), h('div', { class: 'value' }, usd(totalVal, { compact: true }))),
        h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Markets'), h('div', { class: 'value' }, [...new Set(ok.map((a) => a.site.jurisdiction))].join(', '))),
      ),
      h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Rank', 'Site', 'Market / utility', 'Peak kW', 'Recommended', 'Annual value', 'Upfront', 'Payback', 'Score', 'Site check', ''].map((t, i) => h('th', { class: [3, 5, 6, 7].includes(i) ? 'num' : '' }, t)))),
        h('tbody', {},
          ok.map((a, i) => {
            const r = a.recommended;
            const util = a.jurisdiction.utilities.find((u) => u.id === a.site.utility_id);
            return h('tr', {},
              h('td', {}, i + 1),
              h('td', {}, h('strong', {}, a.site.name || a.site.id), h('div', { class: 'small muted' }, a.site.id)),
              h('td', { class: 'small' }, a.site.jurisdiction, ' · ', util?.name || a.site.utility_id),
              h('td', { class: 'num' }, num(a.site.peak_kw)),
              h('td', { class: 'small' }, r?.config.label || '—'),
              h('td', { class: 'num' }, usd(r?.totals.annual_base, { compact: true })),
              h('td', { class: 'num' }, usd(r?.totals.upfront_base, { compact: true })),
              h('td', { class: 'num' }, yrs(r?.finance.base.simplePayback)),
              h('td', {}, badge(`${a.score.score} · ${a.score.grade}`, a.score.score >= 65 ? 'ok' : a.score.score >= 50 ? 'info' : 'caution'), a.score.incomplete ? h('div', {}, badge('rates missing', 'caution')) : null),
              h('td', {}, r ? sevBadge(r.constraints.status) : '—'),
              h('td', {}, h('div', { class: 'btn-row' },
                h('a', { class: 'btn small', href: `#/screener?s=${btoa(unescape(encodeURIComponent(JSON.stringify(a.site))))}` }, 'Open'),
                h('button', { class: 'btn small', onclick: () => { sites = sites.filter((s) => s.id !== a.site.id); storage.set(KEY, sites); compute(); } }, 'Remove'),
              )),
            );
          }),
          analyses.filter((a) => a.error).map((a) => h('tr', {}, h('td', {}, '!'), h('td', { colspan: 10, class: 'small' }, `${a.site.name || a.site.id}: ${a.error}`))),
        ),
      ))),
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
      annual_value_base_usd: a.recommended?.totals.annual_base,
      upfront_base_usd: a.recommended?.totals.upfront_base,
      payback_yr: a.recommended?.finance.base.simplePayback,
      npv_usd: a.recommended?.finance.base.npv,
      constraint_status: a.recommended?.constraints.status,
    }));
    return [
      { name: 'README', rows: README_ROWS },
      { name: 'PortfolioSummary', rows: summary },
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

