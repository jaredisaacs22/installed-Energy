// Site screener: what you know about a site on the left; on the right a cost-free summary and tabs that follow
// the evaluation: demand savings by month, the load data behind them, other systems, site checks, rates and
// programs, export.
import { h, usd, num, yrs, pct, badge, sevBadge, sevIcon, confBadge, toast, storage, initials, sourcesList } from '../ui.js';
import { analyzeSite, buildConfig, BUILDING_SHAPES, loadFactor } from '../engine/index.js';
import { blockText } from '../engine/value.js';
import { demandModel, monthPeaksFor, usesBills, billsOf, billedMonths, MONTHS as DS_MON } from '../engine/demand-savings.js';
import { settingsStore } from '../app.js';
import { xlsx, zip, toCsv, download, siteWorkbookSheets, README_ROWS, configRows, streamRows, tariffRows, programRows, limitRows, panelRows, inputRows, monthlyRows, atlasBlockFor } from '../export.js';
import { addToPortfolio } from './portfolio.js';
import { intervalStore, recordId } from '../interval-store.js';
import { decodeRaw, buildInterval, siteFromWorkbench, intervalPatch, mergeAtlasIntoWorkbench } from '../workbench.js';
import { ingestCsvText, ingestXlsx, selectSheet, reprocess, recordFromState } from '../interval-ingest.js';
import { intervalTab } from './interval-tab.js';
import { dispatchSection } from './dispatch-tab.js';
import { demandTab } from './demand-tab.js';

const SITE_KEY = 'atlas.site';

export const SUPPLY_OPTIONS = [
  ['unknown', 'Unknown'],
  ['passthrough', 'Pass-through / index (tags passed through)'],
  ['index', 'Real-time / hourly index'],
  ['fixed_all_in', 'Fixed all-in price'],
  ['default_service', 'Utility default / bundled service'],
];
export const LOCATIONS = [
  ['outdoor_ground', 'Outdoor, on grade (pad)'],
  ['rooftop', 'Rooftop'],
  ['indoor', 'Indoor (dedicated room)'],
  ['parking_garage', 'Parking garage'],
];
const VOLTAGES = [
  ['208|3', '208 V three-phase'],
  ['240|3', '240 V three-phase'],
  ['480|3', '480 V three-phase'],
  ['240|1', '240 V single-phase'],
];

export function defaultSite(data) {
  const j = data.manifest.jurisdictions[0];
  const jd = data.jurisdictions[j.code];
  const util = jd.utilities[0];
  return normalizeSite(
    {
      name: 'New site',
      jurisdiction: j.code,
      utility_id: util?.id,
      building_type: 'retail',
      peak_kw: 400,
      annual_kwh: 1_400_000,
      service_voltage: 480,
      phases: 3,
      service_amps: 1200,
      main_breaker_amps: 1200,
      busbar_amps: 1200,
      network_secondary: 'unknown',
      install_location: 'outdoor_ground',
      setback_ok: 'unknown',
      flood_zone: 'no',
      supply_contract: 'unknown',
      has_solar: false,
      export_allowed: false,
      disadvantaged_community: false,
    },
    data,
  );
}

/** Keep utility/tariff consistent with the chosen market; fill energy price default. */
export function normalizeSite(site, data) {
  const jd = data.jurisdictions[site.jurisdiction] || data.jurisdictions[data.manifest.jurisdictions[0].code];
  site.jurisdiction = jd.code;
  if (!jd.utilities.some((u) => u.id === site.utility_id)) site.utility_id = jd.utilities[0]?.id;
  const tariffs = jd.tariffs.filter((t) => t.utility_id === site.utility_id);
  if (!tariffs.some((t) => t.id === site.tariff_id)) site.tariff_id = suggestTariff(tariffs, site.peak_kw)?.id || tariffs[0]?.id;
  if (!(site.energy_price > 0)) site.energy_price = jd.default_energy_price_usd_per_kwh ?? null;
  return site;
}

export function suggestTariff(tariffs, peakKw) {
  const fits = tariffs.filter((t) => {
    const a = t.applicability || {};
    return (a.min_kw == null || peakKw >= a.min_kw) && (a.max_kw == null || peakKw <= a.max_kw) && (t.demand_charges || []).length;
  });
  return fits.sort((a, b) => (b.applicability?.min_kw ?? 0) - (a.applicability?.min_kw ?? 0))[0] || null;
}

function siteFromHash(params) {
  const enc = params.get('s');
  if (!enc) return null;
  try {
    return JSON.parse(decodeURIComponent(escape(atob(enc))));
  } catch {
    return null;
  }
}

export function renderScreener(root, data, params) {
  const settings = settingsStore.get(data);
  let site = siteFromHash(params) || storage.get(SITE_KEY, null) || defaultSite(data);
  const marketParam = params.get('market');
  if (marketParam && data.jurisdictions[marketParam] && site.jurisdiction !== marketParam) {
    site = { ...site, jurisdiction: marketParam, utility_id: null, tariff_id: null };
  }
  site = normalizeSite(site, data);
  let selectedId = null;
  let pinned = false; // the user chose a system; otherwise the selection follows the suggested one
  let analysis = null;
  let personaFilter = 'all';
  let panelOpen = false;
  let scenario = 'base';
  let tariffOpen = null; // null = auto (open when rates are missing)
  let resultsTab = params.get('tab') || 'savings';
  resultsTab = { detail: 'savings', panel: 'limits' }[resultsTab] || resultsTab;
  const dispUi = { month: null, day: null, view: 'day', openDispatch: false, openSettings: false }; // Demand savings tab view state
  let ivSession = null; // the live import of the loaded interval file ({ id, state }); lets the user re-process it with other columns
  let ivBusy = null; // name of the file being parsed
  let ivError = null; // { name, msg } of the last failed import
  const ivUi = { wd: null, zoom: null }; // Load data tab view state: worst-day period, year-chart zoom

  const formHost = h('div', { class: 'card form' });
  const formOpen = {}; // which optional form sections are unfolded
  const resultHost = h('div', {});
  root.append(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Site screener'), h('p', {}, 'Open a meter file (or enter the peak), pick the rate or type in the customer’s bills, and see how far a battery cuts each month’s peak and what that saves. Site limits, programs and the expert panel are one tab away.')),
      h('div', { class: 'btn-row no-print' },
        h('button', { class: 'btn', type: 'button', onclick: () => { addToPortfolio(site, data); toast(`Saved ${site.name || 'the site'} to the portfolio`); } }, 'Save to portfolio'),
        h('a', { class: 'btn', href: '#/portfolio' }, 'Open portfolio')),
    ),
    h('div', { class: 'screener' }, formHost, resultHost),
  );

  let timer = null;
  const update = (patch, { rerenderForm = false } = {}) => {
    Object.assign(site, patch);
    if (rerenderForm) normalizeSite(site, data);
    storage.set(SITE_KEY, site);
    if (rerenderForm) renderForm();
    clearTimeout(timer);
    timer = setTimeout(runAnalysis, 120);
  };

  function field(label, input, hint) {
    return h('div', { class: 'field' }, h('label', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  }
  function numInput(key, opts = {}) {
    return h('input', {
      type: 'number',
      inputmode: 'decimal',
      min: opts.min ?? 0,
      step: opts.step ?? 'any',
      value: site[key] ?? '',
      placeholder: opts.placeholder || '',
      'aria-label': opts.label || key,
      // Recalculate while typing; rebuild the form (tariff suggestions, load factor) only once the value is committed,
      // so focus and cursor position are never interrupted mid-entry.
      oninput: (e) => update({ [key]: e.target.value === '' ? null : Number(e.target.value) }),
      onchange: opts.rerender ? () => update({}, { rerenderForm: true }) : null,
    });
  }
  function select(key, options, opts = {}) {
    const sel = h(
      'select',
      { 'aria-label': opts.label || key, onchange: (e) => update({ [key]: e.target.value }, { rerenderForm: !!opts.rerender }) },
      options.map(([v, l]) => h('option', { value: v, selected: String(site[key]) === String(v) }, l)),
    );
    return sel;
  }
  function seg(key, options) {
    return h(
      'div',
      { class: 'seg', role: 'group' },
      options.map(([v, l]) =>
        h('button', { type: 'button', 'aria-pressed': String(site[key]) === String(v) ? 'true' : 'false', onclick: () => update({ [key]: v }, { rerenderForm: true }) }, l),
      ),
    );
  }

  async function importWorkbench(file) {
    let model;
    try {
      model = JSON.parse(await file.text());
    } catch {
      toast('That file is not valid JSON. Pick the <site>-site.json saved by the workbench.');
      return;
    }
    if (!model || typeof model !== 'object' || (!model.meta && !model.raw)) {
      toast('Not a workbench site file (no meta or interval data found).');
      return;
    }
    ivSession = null;
    ivError = null;
    const decoded = model.raw ? decodeRaw(model.raw) : null;
    if (model.raw && !decoded) toast('The interval data block is inconsistent and was ignored.');
    const iv = decoded ? buildInterval(decoded) : null;
    const imp = siteFromWorkbench(model, iv, data);
    const { raw, ...rest } = model;
    const id = recordId(model);
    if (raw) await intervalStore.put({ id, file_name: file.name, imported_at: new Date().toISOString(), model: rest, raw });
    const worst = iv ? worstDayProfile(iv) : null;
    site = normalizeSite(
      {
        ...site,
        ...imp.patch,
        interval_id: raw && iv ? id : null,
        workbench_file: file.name,
        workbench: { ...imp.workbench, notes: imp.notes, warnings: imp.warnings },
        custom_profile: worst,
        shave_kw_override: {},
      },
      data,
    );
    storage.set(SITE_KEY, site);
    pinned = false;
    renderForm();
    runAnalysis();
    toast(imp.warnings.length ? `Imported with ${imp.warnings.length} note${imp.warnings.length > 1 ? 's' : ''} — see the workbench box.` : `Imported ${file.name}.`);
  }

  /** Route a dropped or picked file: workbench site file (.json), Excel workbook, or CSV / TSV text. */
  async function importIntervalFile(file) {
    const ext = ((file.name.match(/\.([^.]+)$/) || [])[1] || '').toLowerCase();
    if (ext === 'json') return importWorkbench(file);
    if (ext === 'xls') {
      ivError = { name: file.name, msg: 'Legacy .xls (binary) is not supported — open it in Excel and re-save as .xlsx, or export CSV.' };
      return refresh();
    }
    ivError = null;
    ivBusy = file.name;
    refresh();
    try {
      const isX = ext === 'xlsx' || ext === 'xlsm';
      const state = isX ? await ingestXlsx(await file.arrayBuffer(), file.name) : ingestCsvText(await file.text(), file.name);
      await adoptState(state);
    } catch (err) {
      ivError = { name: file.name, msg: err.message || String(err) };
      ivBusy = null;
      refresh();
    }
  }

  async function importPasted(text) {
    ivError = null;
    try {
      await adoptState(ingestCsvText(text, 'pasted.csv'));
    } catch (err) {
      ivError = { name: 'Pasted data', msg: err.message || String(err) };
      refresh();
    }
  }

  /** Store a parsed import, take the site's peak, annual kWh and minimum load from it, and show the Load data tab. */
  async function adoptState(state) {
    const probe = recordFromState(state, 'pending');
    const id = recordId({ meta: probe.model.meta, raw: probe.raw });
    await intervalStore.put({ ...probe, id });
    const iv = intervalStore.intervalFor(id);
    if (!iv) throw new Error('No complete day of interval data was found in that file.');
    const ip = intervalPatch(iv);
    ivSession = { id, state };
    ivBusy = null;
    ivUi.wd = null;
    ivUi.zoom = null;
    site = normalizeSite(
      {
        ...site,
        ...ip.patch,
        name: site.name && site.name !== 'New site' ? site.name : probe.model.meta.site,
        interval_id: id,
        workbench_file: probe.file_name,
        workbench: { notes: ip.notes, warnings: ip.warnings },
        custom_profile: worstDayProfile(iv),
        shave_kw_override: {},
      },
      data,
    );
    storage.set(SITE_KEY, site);
    pinned = false;
    resultsTab = 'interval';
    renderForm();
    runAnalysis();
  }

  async function reprocessLoaded(overrides) {
    if (!ivSession) return;
    try {
      await adoptState(reprocess(ivSession.state, overrides));
      ivError = null;
    } catch (err) {
      ivError = { name: ivSession.state.file.name, msg: err.message || String(err) };
      refresh();
    }
  }

  async function switchSheet(name) {
    if (!ivSession) return;
    try {
      await adoptState(await selectSheet(ivSession.state, name));
      ivError = null;
    } catch (err) {
      ivError = { name: ivSession.state.file.name, msg: err.message || String(err) };
      refresh();
    }
  }

  function removeInterval() {
    ivSession = null;
    ivError = null;
    update({ interval_id: null, custom_profile: null, workbench: null, workbench_file: null }, { rerenderForm: true });
  }

  function intervalCtx() {
    const rec = intervalStore.get(site.interval_id);
    return {
      rec,
      analysis: rec ? intervalStore.analysisFor(rec.id) : null,
      live: ivSession && rec && ivSession.id === rec.id ? ivSession.state : null,
      persistent: intervalStore.persistent,
      busy: ivBusy,
      error: ivError,
      ui: ivUi,
      rerender: () => refresh(),
      onFile: importIntervalFile,
      onPaste: importPasted,
      onRemove: removeInterval,
      onReprocess: reprocessLoaded,
      onSheet: switchSheet,
    };
  }

  /** The no-peak state still offers the Interval data import, since loading a file fills the peak in. */
  function renderEmpty() {
    resultHost.replaceChildren(h('div', { class: 'card empty' }, 'Enter the site’s peak demand to start, or load a meter interval file below.'), intervalTab(intervalCtx()));
  }
  const refresh = () => (site.peak_kw > 0 && analysis ? renderResults() : renderEmpty());

  function workbenchBox() {
    const rec = intervalStore.get(site.interval_id);
    const iv = rec ? intervalStore.intervalFor(site.interval_id) : null;
    const input = h('input', { type: 'file', accept: '.json,application/json,.csv,.tsv,.txt,.xlsx,.xlsm', style: { display: 'none' }, 'aria-label': 'Workbench site file', onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importIntervalFile(f); } });
    const wb = site.workbench;
    return h('div', { class: `wb-box${iv ? ' on' : ''}` },
      h('div', { class: 'wb-head' },
        h('div', {}, h('strong', {}, iv ? (rec.source === 'interval-file' ? 'Interval data from a meter file' : 'Interval data from the workbench') : 'Have a meter file or workbench site file?'),
          h('div', { class: 'small muted' }, iv ? `${rec.file_name} · ${iv.start} to ${iv.end} · ${iv.days} days · ${Math.round(iv.dtHours * 60)}-min` : 'Open a meter interval file (CSV or Excel) or the <site>-site.json saved by the Site Analysis Workbench to value the site from its real interval data.')),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small primary', type: 'button', onclick: () => input.click() }, iv ? 'Replace file' : 'Open file'),
          iv ? h('button', { class: 'btn small', type: 'button', onclick: removeInterval }, 'Remove') : null,
        ),
        input,
      ),
      wb && (wb.warnings?.length || wb.notes?.length)
        ? h('ul', { class: 'wb-notes small' }, [...(wb.warnings || []).map((t) => h('li', { class: 'warn' }, t)), ...(wb.notes || []).map((t) => h('li', {}, t))])
        : null,
      site.interval_id && !iv ? h('div', { class: 'small warn' }, 'The interval data for this site is not stored in this browser. Open the file again to use it.') : null,
    );
  }

  /** An optional form section, folded to one line with its current value. */
  function formFold(n, title, sub, ...kids) {
    return h('details', { class: 'form-fold', open: formOpen[n] ? true : null, ontoggle: (e) => { formOpen[n] = e.target.open; } },
      h('summary', {}, h('span', { class: 'step' }, String(n)), h('span', { class: 'ff-title' }, title), h('span', { class: 'ff-sub' }, sub)),
      h('div', { class: 'ff-body' }, ...kids));
  }

  function renderForm() {
    const jd = data.jurisdictions[site.jurisdiction];
    const utils = jd.utilities;
    const tariffs = jd.tariffs.filter((t) => t.utility_id === site.utility_id);
    const sugg = suggestTariff(tariffs, site.peak_kw);
    const lf = loadFactor(site.peak_kw, site.annual_kwh);
    formHost.replaceChildren(
      workbenchBox(),
      h('fieldset', {}, h('legend', {}, h('span', { class: 'step' }, '1'), 'Site & utility'),
        h('div', { class: 'row2' }, field('Site name', h('input', { type: 'text', value: site.name || '', oninput: (e) => update({ name: e.target.value }) })), field('Site ID', h('input', { type: 'text', value: site.id || '', placeholder: 'optional', oninput: (e) => update({ id: e.target.value }) }))),
        field('Market', select('jurisdiction', data.manifest.jurisdictions.map((j) => [j.code, j.name]), { rerender: true })),
        field('Utility', select('utility_id', utils.map((u) => [u.id, u.name]), { rerender: true })),
        field(
          'Rate / tariff',
          select('tariff_id', tariffs.length ? tariffs.map((t) => [t.id, `${t.name}${t.id === sugg?.id ? '  ← suggested' : ''}`]) : [['', 'No tariffs in database']], { rerender: true }),
          sugg ? `Suggested from ${num(site.peak_kw)} kW peak. Confirm the actual rate on the customer's bill.` : 'Confirm the rate on the customer bill.',
        ),
        field('Building type', select('building_type', Object.entries(BUILDING_SHAPES).map(([k, v]) => [k, v.label])), 'Used for the design-day load shape when no interval data is pasted.'),
      ),
      h('fieldset', {}, h('legend', {}, h('span', { class: 'step' }, '2'), 'Load'),
        h('div', { class: 'row2' }, field('Peak demand (kW)', numInput('peak_kw', { rerender: true })), field('Annual usage (kWh)', numInput('annual_kwh', { rerender: true }))),
        h('div', { class: 'hint', style: { marginTop: '-4px', marginBottom: '8px' } }, lf != null ? `Load factor ${pct(lf)}` : 'Add annual kWh to calibrate the load shape'),
        h('div', { class: 'row2' }, field('Minimum load (kW)', numInput('min_load_kw', { placeholder: 'estimated' })), field('All-in energy price ($/kWh)', numInput('energy_price', { step: 0.01 }))),
        h('details', { class: 'adv' }, h('summary', {}, 'Paste a peak-day profile from your interval model'),
          field('24 hourly or 96 fifteen-minute kW values', h('textarea', { placeholder: 'e.g. 210, 205, 200, …', oninput: (e) => {
            const vals = e.target.value.split(/[\s,;]+/).filter(Boolean).map(Number).filter((x) => Number.isFinite(x));
            update({ custom_profile: vals.length === 24 || vals.length === 96 ? vals : null });
          } }, (site.custom_profile || []).join(', ')), site.custom_profile ? `Using pasted profile (${site.custom_profile.length} values).` : 'Overrides the building-type shape. Use the site’s peak day.'),
        ),
      ),
      h('div', { class: 'form-sep' }, 'Optional: size limits and program eligibility'),
      formFold(3, 'Electrical service', site.service_voltage > 0 && site.service_amps > 0 ? `${site.service_voltage} V · ${num(site.service_amps)} A` : 'not entered',
        field('Service voltage', h('select', { onchange: (e) => { const [v, p] = e.target.value.split('|').map(Number); update({ service_voltage: v, phases: p }); } }, VOLTAGES.map(([v, l]) => h('option', { value: v, selected: v === `${site.service_voltage}|${site.phases || 3}` }, l)))),
        h('div', { class: 'row3' }, field('Service (A)', numInput('service_amps')), field('Main breaker (A)', numInput('main_breaker_amps')), field('Busbar (A)', numInput('busbar_amps'))),
        field('On a secondary network grid?', seg('network_secondary', [['no', 'No'], ['yes', 'Yes'], ['unknown', 'Unknown']]), 'Common in Manhattan, downtown Boston, Chicago Loop and downtown SF.'),
      ),
      formFold(4, 'Physical siting', (LOCATIONS.find(([v]) => v === site.install_location) || [, 'not set'])[1],
        field('Install location', select('install_location', LOCATIONS, { rerender: true })),
        h('div', { class: 'row2' }, field('Available area (sq ft)', numInput('available_area_sqft', { placeholder: 'optional' })), field('Flood zone', seg('flood_zone', [['no', 'No'], ['yes', 'Yes'], ['unknown', '?']]))),
        field('~10 ft clearance from buildings, lot lines and egress?', seg('setback_ok', [['yes', 'Yes'], ['no', 'No'], ['unknown', 'Unknown']])),
      ),
      formFold(5, 'Commercial', `supply: ${(SUPPLY_OPTIONS.find(([v]) => v === site.supply_contract) || [, 'unknown'])[1].split(' (')[0].toLowerCase()}`,
        field('Supply contract', select('supply_contract', SUPPLY_OPTIONS), 'Decides whether capacity/transmission tag savings reach the customer.'),
        h('div', { class: 'row2' },
          field('On-site solar', seg('has_solar', [[false, 'No'], [true, 'Yes']])),
          field('Export to grid', seg('export_allowed', [[false, 'No'], [true, 'Yes']])),
        ),
        field('Disadvantaged-community site', seg('disadvantaged_community', [[false, 'No'], [true, 'Yes']]), 'Some programs pay adders here.'),
        field('Customer owns the building (pays property tax)', seg('property_owner', [[false, 'No / unknown'], [true, 'Yes']]), 'Needed for property-tax abatements such as NYC’s.'),
      ),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn small', type: 'button', onclick: () => { site = defaultSite(data); pinned = false; storage.set(SITE_KEY, site); renderForm(); runAnalysis(); } }, 'Reset form')),
    );
    // seg() stores strings for booleans; coerce
    for (const k of ['has_solar', 'export_allowed', 'disadvantaged_community', 'property_owner']) if (typeof site[k] === 'string') site[k] = site[k] === 'true';
  }

  function runAnalysis() {
    for (const k of ['has_solar', 'export_allowed', 'disadvantaged_community', 'property_owner']) if (typeof site[k] === 'string') site[k] = site[k] === 'true';
    if (!(site.peak_kw > 0)) {
      renderEmpty();
      return;
    }
    try {
      analysis = analyzeSite(site, data, settings, { interval: intervalStore.intervalFor(site.interval_id) });
    } catch (err) {
      resultHost.replaceChildren(h('div', { class: 'card' }, h('h3', {}, 'Could not analyze site'), h('pre', {}, String(err.stack || err))));
      return;
    }
    if (!pinned || !selectedId || !analysis.results.some((r) => r.config.id === selectedId)) selectedId = analysis.recommended?.config.id;
    renderResults();
  }

  function renderResults() {
    const a = analysis;
    const sel = a.results.find((r) => r.config.id === selectedId) || a.recommended;
    const jd = a.jurisdiction;
    // Re-rendering replaces inputs; remember which one had focus so typing isn't interrupted.
    const active = document.activeElement;
    const focusLabel = active && resultHost.contains(active) ? active.getAttribute('aria-label') : null;
    const goRates = () => {
      resultsTab = 'rates';
      tariffOpen = true;
      renderResults();
      resultHost.querySelector('details.rate-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const iv = intervalStore.intervalFor(site.interval_id);
    const dm = sel ? demandModel(a, sel, iv, { targets: site.dispatch?.month_targets || {}, forceBills: !!site.bills?.use }) : null;
    const worst = sel ? sel.constraints.status : 'ok';
    const TABS = [
      ['savings', 'Demand savings'],
      ['interval', 'Load data'],
      ['sizing', 'Compare systems'],
      ['limits', worst === 'critical' ? 'Site checks ⚠' : 'Site checks'],
      ['rates', a.missing?.length ? `Rates & programs (${a.missing.length} missing)` : 'Rates & programs'],
      ['export', 'Export'],
    ];
    if (!TABS.some(([id]) => id === resultsTab)) resultsTab = 'savings';
    const pane = (id, ...children) => h('div', { class: `tab-pane${resultsTab === id ? '' : ' tab-hidden'}`, 'data-tab': id }, ...children);
    resultHost.replaceChildren(
      ...[printHeader(a, data),
      sel ? summary(a, sel, dm, iv) : h('div', { class: 'card empty' }, 'No configuration could be evaluated.'),
      accuracyChecklist(a, data, goRates),
      h('div', { class: 'tabs-inline result-tabs no-print', role: 'tablist', style: { marginTop: '16px' } },
        TABS.map(([id, label]) => h('button', { type: 'button', role: 'tab', 'aria-selected': resultsTab === id ? 'true' : 'false', onclick: () => { resultsTab = id; renderResults(); } }, label)),
      ),
      pane('savings', sel ? savingsTab(a, sel, dm, iv, goRates) : null),
      pane('interval', resultsTab === 'interval' ? [iv ? h('div', { class: 'btn-row no-print', style: { marginBottom: '12px' } }, h('button', { class: 'btn small primary', type: 'button', onclick: () => { resultsTab = 'savings'; renderResults(); } }, 'See the demand savings →')) : null, intervalTab(intervalCtx())] : null),
      pane('sizing', compareCard(a, sel), workbenchCheck(a, site)),
      pane('limits', sel ? checksCard(a, sel) : null, limitsCard(a), panelCard(a)),
      pane('rates', tariffCard(a), sel ? valueStackCard(a, sel) : null, programsCard(a, jd)),
      pane('export', exportCard(a, sel, dm))].filter(Boolean),
    );
    if (focusLabel) {
      const el = [...resultHost.querySelectorAll('[aria-label]')].find((x) => x.getAttribute('aria-label') === focusLabel);
      if (el) {
        el.focus();
        if (el.type === 'text' && el.value != null) el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  }

  /** Four numbers that answer "is this a good place for a battery": the peak, the system, the cut, the savings. */
  function summary(a, sel, dm, iv) {
    const peakMonth = Object.entries(dm.holds).reduce((b, [m, x]) => (x && x.peak > (b?.peak ?? -1) ? { m: +m, peak: x.peak } : b), null);
    const isCustom = site.custom_system?.length && sel.config.id === buildConfig(site.custom_system, settings.products).id;
    const billMode = !!site.bills?.use;
    const tile = (label, value, sub, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub));
    const flatOnly = billMode && billsOf(site).flatRate != null && !billedMonths(billsOf(site)).length;
    const savingsSub = billMode
      ? (dm.entered ? (flatOnly ? `at $${num(billsOf(site).flatRate, 2)}/kW from the bills` : `from the customer’s bills${dm.estimated ? ` (${dm.entered} of 12 months entered)` : ''}`) : h('span', { class: 'warn-strong' }, 'enter the bills’ demand charges'))
      : a.tariff ? (a.missing?.length ? h('span', { class: 'warn-strong' }, 'tariff rates missing — enter bills or rates') : `at ${a.tariff.name.split(' - ')[0].split(' (')[0]} rates`) : 'no rate selected';
    const tiles = [
      tile('Peak demand', [num(peakMonth?.peak ?? site.peak_kw, peakMonth?.peak < 100 ? 1 : 0), h('small', {}, ' kW')], iv ? `${peakMonth ? DS_MON[peakMonth.m - 1] + ' · ' : ''}${iv.days} days of interval data` : 'entered · design-day load shape'),
      tile(isCustom ? 'Your system' : sel === a.recommended ? 'Suggested system' : 'Selected system', h('span', { class: 'value-sm' }, sel.config.label), `${num(sel.config.kw)} kW · ${num(sel.config.usableKwh ?? sel.config.kwh * a.assumptions.usable_fraction)} kWh usable`),
      tile('Peak cut', [num(dm.depth.kw, dm.depth.kw < 100 ? 1 : 0), h('small', {}, ' kW')], `${Math.round(dm.depth.pct * 100)}% lower on average, ${iv ? 'held every day of each month' : 'design-day estimate'}`),
      tile('Demand savings', [usd(dm.total), h('small', {}, ' /yr')], savingsSub, 'highlight'),
    ];
    if (a.costsKnown) {
      const f = sel.finance.base;
      tiles.push(tile('Payback', yrs(f.simplePayback), `NPV ${usd(f.npv, { compact: true })} · installed ${usd(sel.config.installedCostUsd, { compact: true })}`));
    }
    return h('div', { class: `kpis result-kpis sum-kpis${a.costsKnown ? ' five' : ''}`, style: { marginBottom: '14px' } }, tiles);
  }

  // Demand savings tab: system, demand charges (tariff or bills), savings by month; dispatch and settings folded.
  function savingsTab(a, r, dm, iv, goRates) {
    const sec = dispatchSection({
      site, a, r, iv,
      products: settings.products,
      ui: dispUi,
      billMode: dm.mode === 'bills' || !!site.bills?.use,
      monthPeaks: monthPeaksFor(site),
      setDispatch,
      setCustomSystem,
      rerender: () => renderResults(),
    });
    return demandTab({
      site, a, sel: r, dm, sec, iv,
      ui: dispUi,
      setBills,
      setDispatch,
      select: pick,
      rerender: () => renderResults(),
      goRates,
    });
  }

  /** Show a system; choosing anything but the suggested one keeps it selected while the inputs change. */
  function pick(id) {
    selectedId = id;
    pinned = id !== analysis?.recommended?.config.id;
    renderResults();
  }

  function setBills(patch) {
    update({ bills: { ...(site.bills || {}), ...patch } });
  }

  function setDispatch(patch) {
    const cur = { ...(site.dispatch || {}), ...patch };
    if (cur.carry) cur.max_daily = false; // carry and "maximize on lighter days" are exclusive; carry wins
    update({ dispatch: cur });
  }

  function setCustomSystem(items) {
    update({ custom_system: items && items.length ? items : null });
    selectedId = items && items.length ? buildConfig(items, settings.products).id : null;
    pinned = !!selectedId;
  }

  /** Every configuration side by side: what it cuts and saves; costs only once real ones are entered. */
  function compareCard(a, sel) {
    const other = (r) => (scenario === 'base' ? r.totals.annual_base : r.totals.annual_upside) - r.streams.filter((x) => x.category === 'demand_charge' && (scenario === 'upside' || x.scenario === 'base')).reduce((n, x) => n + x.annual_usd, 0);
    const maxUsd = Math.max(1, ...a.results.map((r) => r.demand.total));
    const billMode = a.results[0]?.demand.mode === 'bills';
    const heads = ['System', 'kW', 'kWh usable', 'Peak cut', `Demand savings${billMode ? ' (bills)' : ''}`, 'Programs & other value', 'Site check'];
    if (a.costsKnown) heads.push('Installed cost', 'Payback', '10-yr NPV');
    const rows = a.results.map((r) => h('tr', { class: ['click', r.config.id === sel?.config.id ? 'selected' : '', r === a.recommended ? 'rec' : ''].join(' '), onclick: () => { resultsTab = 'savings'; pick(r.config.id); } },
      h('td', {}, r === a.recommended ? h('strong', {}, '★ ', r.config.label) : r.config.label),
      h('td', { class: 'num' }, num(r.config.kw)),
      h('td', { class: 'num' }, num(r.config.usableKwh ?? r.config.kwh * a.assumptions.usable_fraction)),
      h('td', { class: 'num' }, `${num(r.peakCut.kw, r.peakCut.kw < 100 ? 1 : 0)} kW · ${Math.round(r.peakCut.pct * 100)}%`),
      h('td', { class: 'num bar-cell' }, h('span', { class: 'inbar', style: { width: `${Math.round((100 * r.demand.total) / maxUsd)}%` } }), h('span', { class: 'inbar-v' }, usd(r.demand.total))),
      h('td', { class: 'num' }, usd(other(r))),
      h('td', {}, sevBadge(r.constraints.status)),
      ...(a.costsKnown ? [h('td', { class: 'num' }, usd(r.config.installedCostUsd, { compact: true })), h('td', { class: 'num' }, yrs(r.finance[scenario].simplePayback)), h('td', { class: 'num' }, usd(r.finance[scenario].npv, { compact: true }))] : []),
    ));
    const overrides = h('details', { class: 'adv', style: { marginTop: '12px' } }, h('summary', { class: 'small' }, 'Use the demand reduction from your own model (kW per system, tariff valuation only)'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, 'System'), h('th', { class: 'num' }, 'Your model’s kW reduction'))),
        h('tbody', {}, a.results.map((r) => h('tr', {}, h('td', {}, r.config.label), h('td', { class: 'num' }, h('input', { type: 'number', min: 0, step: 'any', 'aria-label': `Demand reduction kW for ${r.config.label}`, value: site.shave_kw_override?.[r.config.id] ?? '', placeholder: num(avgShave(r), 0), onchange: (e) => {
          const o = { ...(site.shave_kw_override || {}) };
          if (e.target.value === '') delete o[r.config.id];
          else o[r.config.id] = Number(e.target.value);
          update({ shave_kw_override: o });
        } }))))))));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Compare systems'),
        h('div', { class: 'seg' }, ['base', 'upside'].map((sc) => h('button', { type: 'button', 'aria-pressed': scenario === sc ? 'true' : 'false', onclick: () => { scenario = sc; renderResults(); } }, sc === 'base' ? 'Base case' : 'Upside case')))),
      h('p', { class: 'small muted' }, `Every system the catalog offers for this site. Peak cut is the average monthly reduction the battery holds on every day of the month; demand savings use ${billMode ? 'the customer’s bills' : 'the selected rate'}. ★ = suggested (${a.costsKnown ? 'highest NPV at your installed costs' : 'smallest system within 3 points of the deepest cut; costs are ignored until you enter real ones in Settings'}). Programs & other value = demand response, peak tags and energy shifting (${scenario === 'base' ? 'base case' : 'upside, incl. waitlisted or unconfirmed programs'}). Click a row to open it on the Demand savings tab.`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'cmp-table' }, h('thead', {}, h('tr', {}, heads.map((t, i) => h('th', { class: i && i !== 6 ? 'num' : '' }, t)))), h('tbody', {}, rows))),
      overrides,
    );
  }

  /** All value streams of the selected system (demand, programs, tags, upfront incentives). */
  function valueStackCard(a, r) {
    const streams = r.streams.slice().sort((x, y) => y.annual_usd + y.upfront_usd / 5 - (x.annual_usd + x.upfront_usd / 5));
    const billMode = r.demand?.mode === 'bills';
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'All value streams'), h('span', { class: 'muted' }, `${r.config.label} · ${num(r.config.kw)} kW · ${num(r.config.kwh)} kWh`)),
      billMode ? h('div', { class: 'check-info', style: { marginBottom: '10px' } }, `The demand-charge rows below are the tariff valuation. The Demand savings tab values demand from the customer’s bills: ${usd(r.demand.total)}/yr for this system.`) : null,
      h('div', { class: 'table-wrap' },
        h('table', {},
          h('thead', {}, h('tr', {}, ['Value stream', 'How it’s calculated', 'Annual', 'Upfront', 'Case', 'Confidence', 'Source'].map((t, i) => h('th', { class: i === 2 || i === 3 ? 'num' : '' }, t)))),
          h('tbody', {},
            streams.map((st) => h('tr', {},
              h('td', {}, st.label, st.flags?.length ? h('div', { class: 'small muted' }, st.flags.map((f) => FLAG_TEXT[f] || f).join(' · ')) : null),
              h('td', { class: 'small ink2' }, st.basis_text, st.notes ? h('div', { class: 'muted' }, st.notes) : null),
              h('td', { class: 'num' }, st.annual_usd ? usd(st.annual_usd) : '—'),
              h('td', { class: 'num' }, st.upfront_usd ? usd(st.upfront_usd) : '—'),
              h('td', {}, badge(st.scenario, st.scenario === 'base' ? 'ok' : 'caution')),
              h('td', {}, confBadge(st.confidence)),
              h('td', { class: 'small' }, streamSource(a, st)),
            )),
            r.excluded.map((st) => h('tr', { class: 'muted' }, h('td', {}, h('s', {}, st.label)), h('td', { class: 'small', colspan: 6 }, st.excluded_reason || `Not stacked: conflicts with ${st.excluded_by}. Only the higher-value program is counted.`))),
          ),
        ),
      ),
    );
  }

  /** Electrical, code and interconnection checks for the selected system. */
  function checksCard(a, r) {
    const order = { critical: 0, caution: 1, info: 2, ok: 3 };
    const checks = r.constraints.checks.slice().sort((x, y) => order[x.severity] - order[y.severity]);
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, `Checks for ${r.config.label}`), sevBadge(r.constraints.status)),
      checks.length ? checks.map((c) => h('div', { class: 'note' },
        h('div', {}, sevIcon(c.severity)),
        h('div', {}, h('div', { class: 'title' }, c.title), h('div', { class: 'text' }, c.detail), c.mitigation ? h('div', { class: 'text' }, h('em', {}, 'Mitigation: '), c.mitigation) : null, sourcesList(c.sources)),
      )) : h('p', { class: 'muted' }, 'No issues found for this system.'),
    );
  }

  function limitsCard(a) {
    const L = a.limits;
    const items = [
      ['Service capacity', L.serviceKva != null ? `${num(L.serviceKva)} kVA` : '—', 'From voltage × service amps'],
      ['Max inverter kW, load-side tap', L.nec120 ? `${num(L.nec120.maxInverterKw)} kW` : '—', 'NEC 705.12 120% rule; supply-side tap or PCS can exceed'],
      ['Charging headroom (overnight)', L.chargeHeadroomKw != null ? `${num(Math.max(0, L.chargeHeadroomKw))} kW` : '—', '80% continuous rating minus overnight load'],
      ['Useful discharge ceiling', L.usefulKwCeiling != null ? `${num(L.usefulKwCeiling)} kW` : 'Export allowed', 'Non-export: discharge can’t exceed site load'],
      ['Minimum load', L.minLoadKw != null ? `${num(L.minLoadKw)} kW` : '—', site.min_load_kw != null ? 'From your input' : 'Design-day estimate'],
      ['Indoor Li-ion limit', L.indoorMaxKwh != null ? `${num(L.indoorMaxKwh)} kWh` : '—', 'Per fire area without special approval'],
      ['Unit size before 9540A data needed', L.unitMaxKwh != null ? `${num(L.unitMaxKwh)} kWh` : '—', 'All four products exceed this; listing + test data required'],
      ...Object.entries(L.maxUnitsBySpace || {}).map(([pid, n]) => [`Max units by space (${pid})`, `${n}`, 'Area ÷ footprint incl. clearances']),
    ];
    const tracks = (L.interconnectionTracks || []).filter((t) => t.max_kw != null);
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'What limits battery size here'), h('span', { class: 'small muted' }, 'Electrical, code and interconnection limits')),
      h('div', { class: 'limits' }, items.map(([k, v, n]) => h('div', { class: 'limit' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), h('div', { class: 'n' }, n)))),
      tracks.length ? h('div', { style: { marginTop: '12px' } }, h('h4', {}, 'Interconnection tracks'), h('div', { class: 'small ink2' }, tracks.map((t) => h('div', {}, h('strong', {}, `${t.name}: `), `≤ ${num(t.max_kw)} kW`, t.conditions ? ` — ${t.conditions}` : '')))) : null,
    );
  }

  function panelCard(a) {
    const personas = Object.fromEntries((data.panel.personas || []).map((p) => [p.id, p]));
    const all = [...a.panel.map((n) => ({ ...n, src: 'review' })), ...a.briefing.map((n) => ({ persona: n.persona_id, severity: n.severity || 'info', title: n.topic, text: n.note, src: 'briefing' }))];
    const ids = [...new Set(all.map((n) => n.persona))];
    const shown = all.filter((n) => personaFilter === 'all' || n.persona === personaFilter);
    const order = { critical: 0, caution: 1, info: 2, ok: 3 };
    shown.sort((x, y) => (x.src === y.src ? order[x.severity] - order[y.severity] : x.src === 'review' ? -1 : 1));
    const crit = all.filter((n) => n.severity === 'critical').length;
    return h('details', { class: 'card fold-card', open: panelOpen ? true : null, ontoggle: (e) => { panelOpen = e.target.open; } },
      h('summary', {}, h('span', { class: 'fold-title' }, `Expert panel review (${all.length})`), crit ? h('span', { class: 'badge critical' }, `${crit} critical`) : null, h('span', { class: 'small muted' }, 'Simulated advisory personas. Not affiliated with the named companies.')),
      h('div', { class: 'persona-filter' },
        h('button', { class: 'chip', 'aria-pressed': personaFilter === 'all' ? 'true' : 'false', onclick: () => { personaFilter = 'all'; renderResults(); } }, `All (${all.length})`),
        ids.map((id) => h('button', { class: 'chip', 'aria-pressed': personaFilter === id ? 'true' : 'false', onclick: () => { personaFilter = id; renderResults(); } }, `${personas[id]?.short || personas[id]?.name || id} (${all.filter((n) => n.persona === id).length})`)),
      ),
      shown.map((n) => noteEl(n, personas[n.persona])),
    );
  }

  function eventWindowSelect(p) {
    const opts = p.dispatch?.event_block_options;
    if (!opts?.length) return null;
    const def = p.dispatch.event_block;
    const cur = site.event_blocks?.[p.id] || `${def.start}-${def.end}`;
    return h('label', { class: 'small inline-field' }, 'Event window ',
      h('select', { 'aria-label': `Event window for ${p.name}`, onchange: (e) => {
        const o = { ...(site.event_blocks || {}) };
        const v = e.target.value;
        if (v === `${def.start}-${def.end}`) delete o[p.id];
        else o[p.id] = v;
        update({ event_blocks: o });
      } }, opts.map((b) => h('option', { value: `${b.start}-${b.end}`, selected: cur === `${b.start}-${b.end}` }, `${blockText(b)}${b.start === def.start && b.end === def.end ? ' (default)' : ''}`))),
      p.dispatch.event_block_notes ? h('span', { class: 'muted', title: p.dispatch.event_block_notes }, ' ⓘ') : null);
  }

  function programsCard(a) {
    const rows = a.programs.slice().sort((x, y) => Number(y.eligible) - Number(x.eligible));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Programs & incentives in this territory'), h('a', { href: `#/library?market=${encodeURIComponent(site.jurisdiction)}`, class: 'small' }, 'Open in library →')),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Program', 'Status', 'Rate', 'Eligible (recommended config)', 'Your rate override', 'Confirmed eligible'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.map(({ program: p, eligible, reason, viaAggregator }) => h('tr', {},
          h('td', {}, h('div', {}, p.name), h('div', { class: 'small muted' }, p.administrator || p.category), eventWindowSelect(p)),
          h('td', {}, badge(p.status, p.status)),
          h('td', { class: 'small' }, p.valuation?.rate != null ? `${p.valuation.rate} ${p.valuation.unit || ''}` : h('span', { class: 'muted' }, 'n/a')),
          h('td', { class: 'small' }, eligible ? (viaAggregator ? badge('via aggregator', 'info') : badge('yes', 'ok')) : badge('no', 'closed'), reason ? h('div', { class: 'muted' }, reason) : null,
            a.recommended?.strategy?.skipped_ids.includes(p.id) ? h('div', {}, badge('not enrolled — costs more than it pays', 'caution')) : null),
          h('td', {}, p.valuation?.rate != null && p.valuation.method !== 'text_only' ? h('input', { type: 'number', step: 'any', value: site.program_rate_overrides?.[p.id] ?? '', placeholder: String(p.valuation.rate), 'aria-label': `Rate override for ${p.name}`, onchange: (e) => {
            const o = { ...(site.program_rate_overrides || {}) };
            if (e.target.value === '') delete o[p.id];
            else o[p.id] = Number(e.target.value);
            update({ program_rate_overrides: o });
          } }) : null),
          h('td', {}, p.requires_confirmation ? h('label', { class: 'small', title: p.requires_confirmation }, h('input', { type: 'checkbox', checked: !!site.confirmed_programs?.[p.id], 'aria-label': `Confirmed eligible: ${p.name}`, onchange: (e) => {
            const o = { ...(site.confirmed_programs || {}) };
            if (e.target.checked) o[p.id] = true;
            else delete o[p.id];
            update({ confirmed_programs: o });
          } }), ' counts in base') : null),
        ))),
      )),
    );
  }

  function tariffCard(a) {
    const t = a.tariff;
    if (!t) return h('div', { class: 'banner' }, 'No tariff selected. Demand-charge and arbitrage savings are excluded. Pick a rate, or add one in data/jurisdictions.');
    const base = a.jurisdiction.tariffs.find((x) => x.id === t.id);
    const setOv = (kind, i, v) => {
      const o = { demand: { ...(site.tariff_overrides?.demand || {}) }, cp: { ...(site.tariff_overrides?.cp || {}) } };
      if (v === '') delete o[kind][i];
      else o[kind][i] = Number(v);
      update({ tariff_overrides: o });
    };
    const autoOpen = (base.demand_charges || []).some((d) => d.rate_usd_per_kw_month == null && d.basis !== 'contract' && d.basis !== 'coincident');
    return h('details', { class: 'card rate-panel', open: tariffOpen ?? autoOpen, ontoggle: (e) => { tariffOpen = e.target.open; } },
      h('summary', { style: { cursor: 'pointer' } }, h('strong', {}, `Rate: ${t.name}`), ' ', confBadge(t.confidence), ' ', h('span', { class: 'small muted' }, t.effective_date ? `effective ${t.effective_date} · ` : '', 'click to review or enter rates from the customer bill')),
      h('div', { class: 'table-wrap', style: { marginTop: '10px' } }, h('table', {},
        h('thead', {}, h('tr', {}, ['Charge', 'Basis', 'Months', 'Window', 'Database rate', 'Bill override'].map((x) => h('th', {}, x)))),
        h('tbody', {},
          (base.demand_charges || []).map((d, i) => h('tr', {},
            h('td', {}, d.label, d.notes ? h('div', { class: 'small muted' }, d.notes) : null),
            h('td', { class: 'small' }, d.basis || ''),
            h('td', { class: 'small' }, d.months?.length && d.months.length < 12 ? d.months.join(',') : 'all'),
            h('td', { class: 'small' }, d.window ? `${d.window.start}:00–${d.window.end}:00${d.days ? ' ' + d.days : ''}` : d.hours || 'all hours'),
            h('td', { class: 'num' }, d.rate_usd_per_kw_month != null ? `$${d.rate_usd_per_kw_month}/${d.basis === 'daily' ? 'kW-day' : 'kW-mo'}` : h('span', { class: 'muted' }, 'not verified')),
            h('td', {}, h('input', { type: 'number', step: 'any', value: site.tariff_overrides?.demand?.[i] ?? '', placeholder: d.rate_usd_per_kw_month ?? 'enter', 'aria-label': `Override ${d.label}`, onchange: (e) => setOv('demand', i, e.target.value) })),
          )),
          (base.coincident_peak_charges || []).map((c, i) => h('tr', {},
            h('td', {}, `Peak tag: ${c.type}`, h('div', { class: 'small muted' }, c.how_set || '')),
            h('td', { class: 'small' }, 'coincident'),
            h('td', { class: 'small' }, '—'),
            h('td', { class: 'small' }, '—'),
            h('td', { class: 'num' }, c.est_value_usd_per_kw_year != null ? `$${c.est_value_usd_per_kw_year}/kW-yr` : h('span', { class: 'muted' }, 'not verified')),
            h('td', {}, h('input', { type: 'number', step: 'any', value: site.tariff_overrides?.cp?.[i] ?? '', placeholder: c.est_value_usd_per_kw_year ?? 'enter', 'aria-label': `Override tag value ${c.type}`, onchange: (e) => setOv('cp', i, e.target.value) })),
          )),
        ),
      )),
      t.ratchet ? h('p', { class: 'small' }, h('strong', {}, 'Ratchet: '), `${t.ratchet.pct != null ? Math.round(t.ratchet.pct * 100) + '%' : ''} ${t.ratchet.applies_to || ''} ${t.ratchet.lookback_months ? `(${t.ratchet.lookback_months}-month lookback)` : ''}`) : null,
      t.storage_notes ? h('p', { class: 'small ink2' }, t.storage_notes) : null,
      t.verification_notes ? h('p', { class: 'small muted' }, t.verification_notes) : null,
      sourcesList(t.sources),
    );
  }

  function exportCard(a, sel, dm) {
    const base = (site.id || site.name || 'site').replace(/[^\w-]+/g, '_').slice(0, 40);
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Export & share'), h('span', { class: 'small muted' }, 'Hand the parameters to your interval-data model')),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', onclick: () => download(`${base}_bess_screen.xlsx`, xlsx(siteWorkbookSheets(a, README_ROWS, { selected: sel, dm })), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') }, 'Download Excel (.xlsx)'),
        h('button', { class: 'btn', onclick: () => download(`${base}_bess_screen_csv.zip`, zip([
          { name: 'inputs.csv', data: toCsv(inputRows(a)) },
          { name: 'demand_by_month.csv', data: toCsv(monthlyRows(a, sel, dm)) },
          { name: 'configs.csv', data: toCsv(configRows(a)) },
          { name: 'value_streams.csv', data: toCsv(streamRows(a)) },
          { name: 'tariff_params.csv', data: toCsv(tariffRows(a)) },
          { name: 'programs.csv', data: toCsv(programRows(a)) },
          { name: 'site_limits.csv', data: toCsv(limitRows(a)) },
          { name: 'panel.csv', data: toCsv(panelRows(a)) },
        ]), 'application/zip') }, 'Download CSVs (.zip)'),
        h('button', { class: 'btn', title: 'The workbench file with Atlas results added under “atlas”. Interval data and every workbench setting are kept unchanged.', onclick: () => {
          const rec = intervalStore.get(site.interval_id);
          const original = rec ? { ...rec.model, raw: rec.raw } : null;
          const merged = mergeAtlasIntoWorkbench(original, atlasBlockFor(a, data));
          const name = (merged.meta?.site || base).replace(/[^\w\-]+/g, '_');
          download(`${name}-site.json`, JSON.stringify(merged, null, 2), 'application/json');
        } }, intervalStore.get(site.interval_id) ? 'Download site file for the workbench' : 'Download workbench site file (.json)'),
        h('button', { class: 'btn', onclick: () => { addToPortfolio(site, data); toast('Saved to portfolio'); } }, 'Save to portfolio'),
        h('button', { class: 'btn', onclick: () => {
          const enc = btoa(unescape(encodeURIComponent(JSON.stringify(site))));
          const url = `${location.origin}${location.pathname}#/screener?s=${enc}`;
          navigator.clipboard?.writeText(url).then(() => toast('Link copied'), () => prompt('Copy this link', url));
        } }, 'Copy share link'),
        h('button', { class: 'btn', onclick: () => window.print() }, 'Print site report'),
      ),
      h('p', { class: 'small muted', style: { marginTop: '8px' } }, `Workbook sheets: Inputs, DemandByMonth (${sel ? sel.config.label : 'the selected system'}), Configs, ValueStreams (long format), TariffParams (demand windows & rates for bill modeling), Programs, SiteLimits, Panel. See Methodology → Export schema.`),
      h('p', { class: 'small muted' }, 'The workbench site file keeps everything the workbench saved (interval data included) and adds Atlas results under “atlas”: the recommended system, every configuration’s value and payback, tariff parameters, site limits and panel cautions. It opens in the workbench as before.'),
    );
  }

  renderForm();
  runAnalysis();
}

const FLAG_TEXT = {
  ratchet: 'ratchet tariff',
  fixed_supply_contract: 'held back by fixed supply contract',
  supply_unknown: 'upside until the supply contract is confirmed to pass tags through',
  default_service_no_tags: 'default service does not pass tags through',
  optional_election: 'optional rate election',
  event_days_limit_shave: 'limited on DR event days',
  eligibility_unconfirmed: 'eligibility unconfirmed — tick “Confirmed eligible” to count in base',
  property_owner_only: 'building owner only',
  feoc_unconfirmed: 'upside until FEOC/MACR compliance is confirmed (Settings)',
  pwa_unconfirmed: 'no prevailing-wage confirmation (≥ 1 MW)',
  duration_assumed: 'event duration assumed',
  aggregator_required: 'via aggregator / CSP',
  duration_short: 'battery shorter than event duration',
};

/** The interval data's peak day as a profile (missing intervals filled from neighbours), for display/fallback. */
function worstDayProfile(iv) {
  let best = null;
  for (const md of Object.values(iv.months)) for (const d of md.days) {
    const mx = Math.max(...d.kw.filter(Number.isFinite));
    if (!best || mx > best.mx) best = { mx, kw: d.kw };
  }
  if (!best) return null;
  const out = best.kw.slice();
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) out[i] = Number.isFinite(out[i - 1]) ? out[i - 1] : 0;
  return out.map((x) => Math.round(x * 10) / 10);
}

/** Cross-check against the workbench: its selected system as valued here, and bill-implied $/kW. */
function workbenchCheck(a, site) {
  const wb = site.workbench;
  if (!wb) return null;
  const rows = [];
  if (wb.selected) {
    const match = wb.selectedConfigId ? a.results.find((r) => r.config.id === wb.selectedConfigId) : null;
    const rank = match ? [...a.results].sort((x, y) => (y.finance.base.npv ?? -Infinity) - (x.finance.base.npv ?? -Infinity)).indexOf(match) + 1 : null;
    rows.push(h('li', {}, h('strong', {}, 'Workbench selected system: '), `${wb.selected}. `,
      match ? `Valued here at ${usd(match.totals.annual_base)}/yr (base), payback ${match.finance.base.simplePayback != null ? yrs(match.finance.base.simplePayback) : 'none'}, rank ${rank} of ${a.results.length} by NPV.` : 'Not in the Atlas product catalog (only the four standard units map), so it is not valued here.'));
  }
  if (wb.billRate && a.tariff) {
    const charges = (a.tariff.demand_charges || []).filter((d) => typeof d.rate_usd_per_kw_month === 'number' && d.basis !== 'contract' && d.basis !== 'coincident');
    const summer = charges.reduce((n, d) => n + d.rate_usd_per_kw_month, 0);
    const diff = summer > 0 ? (wb.billRate - summer) / summer : null;
    rows.push(h('li', { class: diff != null && Math.abs(diff) > 0.25 ? 'warn' : '' }, h('strong', {}, 'Bills: '), `${wb.billMonths} months of bills average $${num(wb.billRate, 2)} per billed kW. The selected rate’s demand charges add up to $${num(summer, 2)}/kW if every element hits the same peak (it varies by month and window). `,
      diff != null && Math.abs(diff) > 0.25 ? 'That is a large gap: confirm the rate class, or enter the bill’s demand rates in Rates & programs.' : 'Broadly consistent.'));
  }
  if (wb.drUsdPerKwYr) rows.push(h('li', {}, h('strong', {}, 'Workbench DR estimate: '), `$${num(wb.drUsdPerKwYr)}/kW-yr. Atlas values the territory’s programs individually (Rates & programs → All value streams).`));
  if (!rows.length) return null;
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Workbench cross-check'), h('span', { class: 'small muted' }, site.workbench_file || '')), h('ul', { class: 'wb-check' }, rows));
}

function avgShave(r) {
  const d = r.streams.filter((s) => s.category === 'demand_charge');
  return d.length ? Math.max(...d.map((s) => s.kw_used || 0)) : 0;
}

export function noteEl(n, persona) {
  const cls = persona?.kind === 'utility' ? 'utility' : persona ? 'specialist' : '';
  return h('div', { class: 'note' },
    h('div', { class: `avatar ${cls}`, title: persona?.name || n.persona }, persona?.initials || initials(persona?.name || n.persona)),
    h('div', {},
      h('div', { class: 'who' }, persona?.name || n.persona, n.src === 'briefing' ? ' · market briefing' : ''),
      h('div', { class: 'title' }, sevIcon(n.severity), n.title),
      h('div', { class: 'text' }, n.text),
    ),
  );
}

/** Source link for a value stream: the program's or tariff's first source. */
function streamSource(a, st) {
  let src = null;
  if (st.program_id) src = a.programs.find((x) => x.program.id === st.program_id)?.program.sources?.[0];
  else if (st.category !== 'cost') src = a.tariff?.sources?.[0];
  if (!src?.url) return h('span', { class: 'muted' }, '—');
  return h('a', { href: src.url, target: '_blank', rel: 'noopener', title: src.title || src.url }, 'source ↗');
}

/** Printed report header (hidden on screen). */
function printHeader(a, data) {
  const util = a.jurisdiction.utilities.find((u) => u.id === a.site.utility_id);
  return h('div', { class: 'print-only print-head' },
    h('h1', {}, `Site report — ${a.site.name || a.site.id || 'Unnamed site'}`),
    h('div', {}, `${a.jurisdiction.name} · ${util?.name || a.site.utility_id} · ${a.tariff?.name || 'no tariff'} · peak ${num(a.site.peak_kw)} kW`),
    h('div', { class: 'small muted' }, `Generated ${new Date().toLocaleDateString()} · data ${data.manifest.data_version} · Indicative screening estimate — verify rates, eligibility and costs before investment decisions.`),
  );
}

/**
 * Accuracy checklist: every input that materially changes the answer, with its status and the fix.
 * Planning-grade only when nothing is outstanding.
 */
export function accuracyItems(a, data) {
  const s = a.site;
  const rec = a.recommended;
  const items = [];
  const add = (ok, title, detail, action) => items.push({ ok, title, detail, action });
  const missing = a.missing || [];
  if (!usesBills(s)) add(!missing.length, missing.length ? `${missing.length} tariff rate${missing.length > 1 ? 's' : ''} missing` : 'Tariff rates complete', missing.length ? `${missing.join('; ')} — excluded from savings until entered.` : `${a.tariff?.name || ''}${a.tariff?.effective_date ? ` (effective ${a.tariff.effective_date})` : ''}.`, missing.length ? 'rates' : null);
  const lowTariff = a.tariff?.confidence === 'low' && (a.tariff.demand_charges || []).some((d) => typeof d.rate_usd_per_kw_month === 'number' && !d.overridden);
  if (a.tariff) add(!lowTariff, lowTariff ? 'Tariff rates are low-confidence' : `Tariff confidence: ${a.tariff.confidence || 'n/a'}`, lowTariff ? 'Confirm the demand charges against a recent customer bill and override them in the Rate panel.' : 'Rates come from a primary source or two consistent sources.', lowTariff ? 'rates' : null);
  if (usesBills(s)) {
    const b = billsOf(s);
    const n = billedMonths(b).length;
    add(true, n ? `Demand charges from the customer’s bills (${n} of 12 months)` : `Demand charges at $${num(b.flatRate, 2)}/kW from the bills`, n === 12 ? 'Every month is valued from its own bill.' : b.flatRate != null ? `Months without their own charges use $${num(b.flatRate, 2)}/kW.` : 'Months without charges use the average $/kW of the months entered.', null);
  }
  const iv = a.interval;
  const hasInterval = !!iv || Array.isArray(s.custom_profile) || Object.keys(s.shave_kw_override || {}).length > 0;
  if (iv) add(iv.monthsCovered >= 12, iv.monthsCovered >= 12 ? 'Interval data applied (all days, every month)' : `Interval data covers ${iv.monthsCovered} of 12 months`, `${iv.start} to ${iv.end}, ${iv.days} days. Each month’s demand caps are checked against every day of that month.${iv.monthsCovered < 12 ? ' Missing months use the generic load shape.' : ''}`, null);
  else add(hasInterval, hasInterval ? 'Peak-day profile applied' : 'Demand savings use a generic load shape', hasInterval ? 'A single peak-day profile or kW from your own model is in use. A meter interval file adds every day of every month.' : 'Open a meter interval file (top of the form) so every day of every month is checked, or paste a peak-day profile (step 2).', null);
  const hasTags = (a.tariff?.coincident_peak_charges || []).some((c) => typeof c.est_value_usd_per_kw_year === 'number');
  if (hasTags) add(s.supply_contract && s.supply_contract !== 'unknown', s.supply_contract && s.supply_contract !== 'unknown' ? 'Supply contract set' : 'Supply contract unknown', s.supply_contract && s.supply_contract !== 'unknown' ? 'Peak-tag savings follow the contract’s pass-through terms.' : 'Peak-tag savings are held in upside until you set the contract (step 5).', null);
  const elec = s.service_voltage > 0 && s.service_amps > 0 && (s.busbar_amps > 0 || s.main_breaker_amps > 0);
  add(elec, elec ? 'Electrical service entered' : 'Electrical service missing', elec ? 'NEC 120% and charging-headroom limits are checked.' : 'Enter voltage, service, main breaker and busbar ratings (step 3) to check size limits.', null);
  if (s.network_secondary === 'unknown') add(false, 'Network grid status unknown', 'Confirm with the utility whether the site is on a secondary network; it restricts export and adds review.', null);
  if (a.costsKnown) add(!!a.assumptions.itc_feoc_confirmed, a.assumptions.itc_feoc_confirmed ? 'ITC supply-chain compliance confirmed' : 'ITC counted in upside only', a.assumptions.itc_feoc_confirmed ? 'The 30% credit counts in the base case.' : 'Confirm the batteries meet the FEOC/MACR rules in Settings to count the ITC in the base case.', a.assumptions.itc_feoc_confirmed ? null : 'settings');
  const unconfirmed = (rec?.streams || []).filter((x) => x.flags?.includes('eligibility_unconfirmed'));
  if (unconfirmed.length) add(false, 'Program eligibility to confirm', `${unconfirmed.map((x) => x.label).join('; ')} — counted in upside until you tick “Confirmed eligible” in the programs list.`, null);
  if (rec) {
    const worth = (x) => Math.max(0, x.annual_usd) + Math.max(0, x.upfront_usd) / 5;
    const tot = rec.streams.reduce((n, x) => n + worth(x), 0);
    const low = rec.streams.filter((x) => x.confidence === 'low').reduce((n, x) => n + worth(x), 0);
    if (tot > 0 && low / tot > 0.25) add(false, `${Math.round((100 * low) / tot)}% of value rests on low-confidence data`, 'See Data health for which values to verify.', 'health');
  }
  return items;
}

function accuracyChecklist(a, data, openRates) {
  const items = accuracyItems(a, data);
  const open = items.filter((i) => !i.ok).length;
  const actionEl = (i) => {
    if (i.action === 'rates') return h('button', { class: 'btn small', type: 'button', onclick: openRates }, 'Enter rates');
    if (i.action === 'settings') return h('a', { class: 'btn small', href: '#/settings' }, 'Settings');
    if (i.action === 'health') return h('a', { class: 'btn small', href: '#/health' }, 'Data health');
    return null;
  };
  return h('details', { class: 'card checklist-card' },
    h('summary', {},
      h('span', { class: 'fold-title' }, 'Accuracy checklist'),
      open ? h('span', { class: 'grade-pill screening' }, sevIcon('caution'), `Screening-grade · ${open} item${open > 1 ? 's' : ''} to resolve`) : h('span', { class: 'grade-pill planning' }, sevIcon('ok'), 'Planning-grade inputs'),
    ),
    h('div', { class: 'checklist', style: { marginTop: '10px' } },
      items.sort((x, y) => Number(x.ok) - Number(y.ok)).map((i) => h('div', { class: 'check' }, h('div', {}, sevIcon(i.ok ? 'ok' : 'caution')), h('div', {}, h('div', { class: 't' }, i.title), h('div', { class: 'd' }, i.detail)), h('div', {}, actionEl(i)))),
    ),
  );
}
