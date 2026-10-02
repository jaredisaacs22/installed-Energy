// Site screener: inputs on the left, ranked configurations, value stack, limits and panel review on the right.
import { h, usd, num, yrs, pct, badge, sevBadge, sevIcon, confBadge, toast, storage, initials, sourcesList } from '../ui.js';
import { analyzeSite, BUILDING_SHAPES, loadFactor } from '../engine/index.js';
import { valueStackChart } from '../chart.js';
import { settingsStore } from '../app.js';
import { xlsx, zip, toCsv, download, siteWorkbookSheets, README_ROWS, configRows, streamRows, tariffRows, programRows, limitRows, panelRows, inputRows } from '../export.js';
import { addToPortfolio } from './portfolio.js';

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
  let site = normalizeSite(siteFromHash(params) || storage.get(SITE_KEY, null) || defaultSite(data), data);
  let selectedId = null;
  let analysis = null;
  let personaFilter = 'all';
  let scenario = 'base';

  const formHost = h('div', { class: 'card form' });
  const resultHost = h('div', {});
  root.append(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Site screener'), h('p', {}, 'Enter what you know about a site. Every battery configuration is valued against current tariffs and programs, then checked against electrical, code and program limits and reviewed by the expert panel.')),
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
      oninput: (e) => update({ [key]: e.target.value === '' ? null : Number(e.target.value) }, { rerenderForm: !!opts.rerender }),
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

  function renderForm() {
    const jd = data.jurisdictions[site.jurisdiction];
    const utils = jd.utilities;
    const tariffs = jd.tariffs.filter((t) => t.utility_id === site.utility_id);
    const sugg = suggestTariff(tariffs, site.peak_kw);
    const lf = loadFactor(site.peak_kw, site.annual_kwh);
    formHost.replaceChildren(
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
      h('fieldset', {}, h('legend', {}, h('span', { class: 'step' }, '3'), 'Electrical service'),
        field('Service voltage', h('select', { onchange: (e) => { const [v, p] = e.target.value.split('|').map(Number); update({ service_voltage: v, phases: p }); } }, VOLTAGES.map(([v, l]) => h('option', { value: v, selected: v === `${site.service_voltage}|${site.phases || 3}` }, l)))),
        h('div', { class: 'row3' }, field('Service (A)', numInput('service_amps')), field('Main breaker (A)', numInput('main_breaker_amps')), field('Busbar (A)', numInput('busbar_amps'))),
        field('On a secondary network grid?', seg('network_secondary', [['no', 'No'], ['yes', 'Yes'], ['unknown', 'Unknown']]), 'Common in Manhattan, downtown Boston, Chicago Loop and downtown SF.'),
      ),
      h('fieldset', {}, h('legend', {}, h('span', { class: 'step' }, '4'), 'Physical siting'),
        field('Install location', select('install_location', LOCATIONS, { rerender: true })),
        h('div', { class: 'row2' }, field('Available area (sq ft)', numInput('available_area_sqft', { placeholder: 'optional' })), field('Flood zone', seg('flood_zone', [['no', 'No'], ['yes', 'Yes'], ['unknown', '?']]))),
        field('~10 ft clearance from buildings, lot lines and egress?', seg('setback_ok', [['yes', 'Yes'], ['no', 'No'], ['unknown', 'Unknown']])),
      ),
      h('fieldset', {}, h('legend', {}, h('span', { class: 'step' }, '5'), 'Commercial'),
        field('Supply contract', select('supply_contract', SUPPLY_OPTIONS), 'Decides whether capacity/transmission tag savings reach the customer.'),
        h('div', { class: 'row2' },
          field('On-site solar', seg('has_solar', [[false, 'No'], [true, 'Yes']])),
          field('Export to grid', seg('export_allowed', [[false, 'No'], [true, 'Yes']])),
        ),
        field('Disadvantaged-community site', seg('disadvantaged_community', [[false, 'No'], [true, 'Yes']]), 'Some programs pay adders here.'),
      ),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn small', type: 'button', onclick: () => { site = defaultSite(data); storage.set(SITE_KEY, site); renderForm(); runAnalysis(); } }, 'Reset form')),
    );
    // seg() stores strings for booleans; coerce
    for (const k of ['has_solar', 'export_allowed', 'disadvantaged_community']) if (typeof site[k] === 'string') site[k] = site[k] === 'true';
  }

  function runAnalysis() {
    for (const k of ['has_solar', 'export_allowed', 'disadvantaged_community']) if (typeof site[k] === 'string') site[k] = site[k] === 'true';
    if (!(site.peak_kw > 0)) {
      resultHost.replaceChildren(h('div', { class: 'card empty' }, 'Enter the site’s peak demand to start.'));
      return;
    }
    try {
      analysis = analyzeSite(site, data, settings);
    } catch (err) {
      resultHost.replaceChildren(h('div', { class: 'card' }, h('h3', {}, 'Could not analyze site'), h('pre', {}, String(err.stack || err))));
      return;
    }
    if (!selectedId || !analysis.results.some((r) => r.config.id === selectedId)) selectedId = analysis.recommended?.config.id;
    renderResults();
  }

  function renderResults() {
    const a = analysis;
    const rec = a.recommended;
    const sel = a.results.find((r) => r.config.id === selectedId) || rec;
    const jd = a.jurisdiction;
    resultHost.replaceChildren(
      ...[dataBanner(a, data),
      kpis(a, rec),
      tariffCard(a),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Battery configurations'),
          h('div', { class: 'seg' }, ['base', 'upside'].map((sc) => h('button', { type: 'button', 'aria-pressed': scenario === sc ? 'true' : 'false', onclick: () => { scenario = sc; renderResults(); } }, sc === 'base' ? 'Base case' : 'Upside case')))),
        h('p', { class: 'small muted' }, 'Annual value by stream for each configuration. Click a bar or row for its full breakdown. Upside adds waitlisted or pending programs and tag savings that a fixed supply contract would hold back.'),
        valueStackChart(a.results, { selectedId: sel?.config.id, recommendedId: rec?.config.id, scenario, onSelect: (id) => { selectedId = id; renderResults(); } }),
        configTable(a, sel),
      ),
      sel ? detailCard(a, sel) : null,
      limitsCard(a),
      panelCard(a),
      programsCard(a, jd),
      exportCard(a)].filter(Boolean),
    );
  }

  function configTable(a, sel) {
    const fin = (r) => r.finance[scenario];
    const tot = (r) => (scenario === 'base' ? r.totals.annual_base : r.totals.annual_upside);
    const up = (r) => (scenario === 'base' ? r.totals.upfront_base : r.totals.upfront_upside);
    return h('div', { class: 'table-wrap', style: { marginTop: '10px' } },
      h('table', {},
        h('thead', {}, h('tr', {}, ['Configuration', 'kW', 'kWh', 'Hours', 'Installed cost', 'Annual value', 'Upfront incentives', 'Payback', '10-yr NPV', 'Site check', 'Shave kW (your model)'].map((t, i) => h('th', { class: i && i < 9 ? 'num' : '' }, t)))),
        h('tbody', {},
          a.results.map((r) =>
            h('tr', { class: [r.config.id === sel?.config.id ? 'selected' : '', r === a.recommended ? 'rec' : ''].join(' '), onclick: (e) => { if (e.target.tagName === 'INPUT') return; selectedId = r.config.id; renderResults(); } },
              h('td', {}, r === a.recommended ? h('strong', {}, '★ ', r.config.label) : r.config.label),
              h('td', { class: 'num' }, num(r.config.kw)),
              h('td', { class: 'num' }, num(r.config.kwh)),
              h('td', { class: 'num' }, num(r.config.durationHr, 1)),
              h('td', { class: 'num' }, usd(r.config.installedCostUsd, { compact: true })),
              h('td', { class: 'num' }, usd(tot(r), { compact: true })),
              h('td', { class: 'num' }, usd(up(r), { compact: true })),
              h('td', { class: 'num' }, yrs(fin(r).simplePayback)),
              h('td', { class: 'num' }, usd(fin(r).npv, { compact: true })),
              h('td', {}, sevBadge(r.constraints.status)),
              h('td', {}, h('input', { type: 'number', min: 0, step: 'any', 'aria-label': `Demand reduction kW for ${r.config.label}`, value: site.shave_kw_override?.[r.config.id] ?? '', placeholder: num(avgShave(r), 0), oninput: (e) => {
                const o = { ...(site.shave_kw_override || {}) };
                if (e.target.value === '') delete o[r.config.id];
                else o[r.config.id] = Number(e.target.value);
                site.shave_kw_override = o;
                storage.set(SITE_KEY, site);
                clearTimeout(timer);
                timer = setTimeout(runAnalysis, 400);
              } })),
            ),
          ),
        ),
      ),
    );
  }

  function detailCard(a, r) {
    const streams = r.streams.slice().sort((x, y) => y.annual_usd + y.upfront_usd / 5 - (x.annual_usd + x.upfront_usd / 5));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, r.config.label), h('span', { class: 'muted' }, `${num(r.config.kw)} kW · ${num(r.config.kwh)} kWh · ${num(r.config.durationHr, 1)} h · ${r.config.units} unit${r.config.units > 1 ? 's' : ''}`)),
      h('div', { class: 'table-wrap' },
        h('table', {},
          h('thead', {}, h('tr', {}, ['Value stream', 'How it’s calculated', 'Annual', 'Upfront', 'Case', 'Confidence'].map((t, i) => h('th', { class: i === 2 || i === 3 ? 'num' : '' }, t)))),
          h('tbody', {},
            streams.map((st) => h('tr', {},
              h('td', {}, st.label, st.flags?.length ? h('div', { class: 'small muted' }, st.flags.map((f) => FLAG_TEXT[f] || f).join(' · ')) : null),
              h('td', { class: 'small ink2' }, st.basis_text, st.notes ? h('div', { class: 'muted' }, st.notes) : null),
              h('td', { class: 'num' }, st.annual_usd ? usd(st.annual_usd) : '—'),
              h('td', { class: 'num' }, st.upfront_usd ? usd(st.upfront_usd) : '—'),
              h('td', {}, badge(st.scenario, st.scenario === 'base' ? 'ok' : 'caution')),
              h('td', {}, confBadge(st.confidence)),
            )),
            r.excluded.map((st) => h('tr', { class: 'muted' }, h('td', {}, h('s', {}, st.label)), h('td', { class: 'small', colspan: 5 }, `Not stacked: conflicts with ${st.excluded_by}. Only the higher-value program is counted.`))),
          ),
        ),
      ),
      h('h3', { style: { marginTop: '14px' } }, 'Site checks for this configuration'),
      r.constraints.checks.map((c) => h('div', { class: 'note' },
        h('div', {}, sevIcon(c.severity)),
        h('div', {}, h('div', { class: 'title' }, c.title), h('div', { class: 'text' }, c.detail), c.mitigation ? h('div', { class: 'text' }, h('em', {}, 'Mitigation: '), c.mitigation) : null, sourcesList(c.sources)),
      )),
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
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Expert panel review'), h('span', { class: 'small muted' }, 'Simulated advisory personas. Not affiliated with the named companies.')),
      h('div', { class: 'persona-filter' },
        h('button', { class: 'chip', 'aria-pressed': personaFilter === 'all' ? 'true' : 'false', onclick: () => { personaFilter = 'all'; renderResults(); } }, `All (${all.length})`),
        ids.map((id) => h('button', { class: 'chip', 'aria-pressed': personaFilter === id ? 'true' : 'false', onclick: () => { personaFilter = id; renderResults(); } }, `${personas[id]?.short || personas[id]?.name || id} (${all.filter((n) => n.persona === id).length})`)),
      ),
      shown.map((n) => noteEl(n, personas[n.persona])),
    );
  }

  function programsCard(a) {
    const rows = a.programs.slice().sort((x, y) => Number(y.eligible) - Number(x.eligible));
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Programs & incentives in this territory'), h('a', { href: `#/library?market=${encodeURIComponent(site.jurisdiction)}`, class: 'small' }, 'Open in library →')),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Program', 'Status', 'Rate', 'Eligible (recommended config)', 'Your rate override'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.map(({ program: p, eligible, reason, viaAggregator }) => h('tr', {},
          h('td', {}, h('div', {}, p.name), h('div', { class: 'small muted' }, p.administrator || p.category)),
          h('td', {}, badge(p.status, p.status)),
          h('td', { class: 'small' }, p.valuation?.rate != null ? `${p.valuation.rate} ${p.valuation.unit || ''}` : h('span', { class: 'muted' }, 'n/a')),
          h('td', { class: 'small' }, eligible ? (viaAggregator ? badge('via aggregator', 'info') : badge('yes', 'ok')) : badge('no', 'closed'), reason ? h('div', { class: 'muted' }, reason) : null),
          h('td', {}, p.valuation?.rate != null && p.valuation.method !== 'text_only' ? h('input', { type: 'number', step: 'any', value: site.program_rate_overrides?.[p.id] ?? '', placeholder: String(p.valuation.rate), 'aria-label': `Rate override for ${p.name}`, oninput: (e) => {
            const o = { ...(site.program_rate_overrides || {}) };
            if (e.target.value === '') delete o[p.id];
            else o[p.id] = Number(e.target.value);
            update({ program_rate_overrides: o });
          } }) : null),
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
    return h('details', { class: 'card', open: (base.demand_charges || []).some((d) => d.rate_usd_per_kw_month == null) },
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
            h('td', {}, h('input', { type: 'number', step: 'any', value: site.tariff_overrides?.demand?.[i] ?? '', placeholder: d.rate_usd_per_kw_month ?? 'enter', 'aria-label': `Override ${d.label}`, oninput: (e) => setOv('demand', i, e.target.value) })),
          )),
          (base.coincident_peak_charges || []).map((c, i) => h('tr', {},
            h('td', {}, `Peak tag: ${c.type}`, h('div', { class: 'small muted' }, c.how_set || '')),
            h('td', { class: 'small' }, 'coincident'),
            h('td', { class: 'small' }, '—'),
            h('td', { class: 'small' }, '—'),
            h('td', { class: 'num' }, c.est_value_usd_per_kw_year != null ? `$${c.est_value_usd_per_kw_year}/kW-yr` : h('span', { class: 'muted' }, 'not verified')),
            h('td', {}, h('input', { type: 'number', step: 'any', value: site.tariff_overrides?.cp?.[i] ?? '', placeholder: c.est_value_usd_per_kw_year ?? 'enter', 'aria-label': `Override tag value ${c.type}`, oninput: (e) => setOv('cp', i, e.target.value) })),
          )),
        ),
      )),
      t.ratchet ? h('p', { class: 'small' }, h('strong', {}, 'Ratchet: '), `${t.ratchet.pct != null ? Math.round(t.ratchet.pct * 100) + '%' : ''} ${t.ratchet.applies_to || ''} ${t.ratchet.lookback_months ? `(${t.ratchet.lookback_months}-month lookback)` : ''}`) : null,
      t.storage_notes ? h('p', { class: 'small ink2' }, t.storage_notes) : null,
      t.verification_notes ? h('p', { class: 'small muted' }, t.verification_notes) : null,
      sourcesList(t.sources),
    );
  }

  function exportCard(a) {
    const base = (site.id || site.name || 'site').replace(/[^\w-]+/g, '_').slice(0, 40);
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Export & share'), h('span', { class: 'small muted' }, 'Hand the parameters to your interval-data model')),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', onclick: () => download(`${base}_bess_screen.xlsx`, xlsx(siteWorkbookSheets(a, README_ROWS)), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') }, 'Download Excel (.xlsx)'),
        h('button', { class: 'btn', onclick: () => download(`${base}_bess_screen_csv.zip`, zip([
          { name: 'inputs.csv', data: toCsv(inputRows(a)) },
          { name: 'configs.csv', data: toCsv(configRows(a)) },
          { name: 'value_streams.csv', data: toCsv(streamRows(a)) },
          { name: 'tariff_params.csv', data: toCsv(tariffRows(a)) },
          { name: 'programs.csv', data: toCsv(programRows(a)) },
          { name: 'site_limits.csv', data: toCsv(limitRows(a)) },
          { name: 'panel.csv', data: toCsv(panelRows(a)) },
        ]), 'application/zip') }, 'Download CSVs (.zip)'),
        h('button', { class: 'btn', onclick: () => { addToPortfolio(site, data); toast('Saved to portfolio'); } }, 'Save to portfolio'),
        h('button', { class: 'btn', onclick: () => {
          const enc = btoa(unescape(encodeURIComponent(JSON.stringify(site))));
          const url = `${location.origin}${location.pathname}#/screener?s=${enc}`;
          navigator.clipboard?.writeText(url).then(() => toast('Link copied'), () => prompt('Copy this link', url));
        } }, 'Copy share link'),
        h('button', { class: 'btn', onclick: () => window.print() }, 'Print'),
      ),
      h('p', { class: 'small muted', style: { marginTop: '8px' } }, 'Workbook sheets: Inputs, Configs, ValueStreams (long format), TariffParams (demand windows & rates for bill modeling), Programs, SiteLimits, Panel. See Methodology → Export schema.'),
    );
  }

  renderForm();
  runAnalysis();
}

const FLAG_TEXT = {
  ratchet: 'ratchet tariff',
  fixed_supply_contract: 'held back by fixed supply contract',
  aggregator_required: 'via aggregator / CSP',
  duration_short: 'battery shorter than event duration',
};

function avgShave(r) {
  const d = r.streams.filter((s) => s.category === 'demand_charge');
  return d.length ? Math.max(...d.map((s) => s.kw_used || 0)) : 0;
}

export function noteEl(n, persona) {
  const isUtil = persona?.kind === 'utility';
  return h('div', { class: 'note' },
    h('div', { class: `avatar ${isUtil ? 'utility' : ''}`, title: persona?.name || n.persona }, persona?.initials || initials(persona?.name || n.persona)),
    h('div', {},
      h('div', { class: 'who' }, persona?.name || n.persona, n.src === 'briefing' ? ' · market briefing' : ''),
      h('div', { class: 'title' }, sevIcon(n.severity), n.title),
      h('div', { class: 'text' }, n.text),
    ),
  );
}

function dataBanner(a, data) {
  const settings = settingsStore.get(data);
  const placeholder = settings.products.some((p) => p.cost_is_placeholder && settings.raw?.products?.[p.id]?.installed_cost_usd_per_kwh == null);
  const t = a.tariff;
  const missing = t ? (t.demand_charges || []).filter((d) => d.rate_usd_per_kw_month == null && d.basis !== 'contract' && d.basis !== 'coincident').length : 0;
  const msgs = [];
  if (placeholder) msgs.push(h('span', {}, 'Installed costs are a $600/kWh placeholder, so payback, NPV and the recommendation are only indicative. ', h('a', { href: '#/settings' }, 'Enter your costs in Settings'), '.'));
  if (t && missing) msgs.push(`${missing} demand charge${missing > 1 ? 's' : ''} on ${t.name} ha${missing > 1 ? 've' : 's'} no verified rate and ${missing > 1 ? 'are' : 'is'} excluded. Enter rates from the customer bill in the Rate panel below.`);
  if (t && t.confidence === 'low') msgs.push(`${t.name} rates are low-confidence. Check them against the current tariff before relying on them.`);
  if (!msgs.length) return null;
  return h('div', { class: 'banner' }, msgs.map((m) => h('div', {}, m)));
}

function kpis(a, rec) {
  const sc = a.score;
  const ring = (val) => {
    const C = 2 * Math.PI * 26;
    const wrap = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    wrap.setAttribute('viewBox', '0 0 64 64');
    wrap.setAttribute('class', 'ring');
    wrap.innerHTML = `<circle cx="32" cy="32" r="26" fill="none" stroke="var(--line)" stroke-width="7"/><circle cx="32" cy="32" r="26" fill="none" stroke="var(--accent)" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(C * val) / 100} ${C}" transform="rotate(-90 32 32)"/><text x="32" y="37" text-anchor="middle" font-size="15" font-weight="700" fill="var(--ink)" font-family="system-ui">${val}</text>`;
    return wrap;
  };
  if (!rec) return h('div', { class: 'card empty' }, 'No configuration could be evaluated.');
  const f = rec.finance.base;
  return h('div', { class: 'kpis', style: { marginBottom: '14px' } },
    h('div', { class: 'kpi score', title: `Economics ${sc.parts.economics} · Certainty ${sc.parts.certainty} · Feasibility ${sc.parts.feasibility}` }, ring(sc.score), h('div', {}, h('div', { class: 'label' }, 'Site score'), h('div', { class: 'grade' }, sc.grade), h('div', { class: 'sub' }, sc.basis))),
    h('div', { class: 'kpi' }, h('div', { class: 'label' }, f.npv != null && f.npv < 0 ? 'Best available (NPV negative)' : 'Recommended'), h('div', { class: 'value', style: { fontSize: '16px' } }, rec.config.label), h('div', { class: 'sub' }, f.npv != null && f.npv < 0 ? 'No option pays back within the analysis horizon at current cost assumptions' : `${num(rec.config.kw)} kW · ${num(rec.config.kwh)} kWh · highest NPV of feasible options`)),
    h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Annual value (base)'), h('div', { class: 'value' }, usd(rec.totals.annual_base)), h('div', { class: 'sub' }, `Upside ${usd(rec.totals.annual_upside)}`)),
    h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Upfront incentives + ITC'), h('div', { class: 'value' }, usd(rec.totals.upfront_base)), h('div', { class: 'sub' }, `Installed cost ${usd(rec.config.installedCostUsd)}`)),
    h('div', { class: 'kpi' }, h('div', { class: 'label' }, 'Simple payback'), h('div', { class: 'value' }, yrs(f.simplePayback)), h('div', { class: 'sub' }, `NPV ${usd(f.npv, { compact: true })} · IRR ${f.irr != null ? pct(f.irr) : '—'}`)),
  );
}
