// Settings: product catalog (your SKUs, costs, footprints) and modeling assumptions. Stored per browser.
import { h, toast } from '../ui.js';
import { settingsStore } from '../app.js';

export function renderSettings(root, data) {
  const current = settingsStore.get(data);
  const raw = JSON.parse(JSON.stringify(current.raw || {}));
  raw.products = raw.products || {};
  raw.assumptions = raw.assumptions || {};
  const save = () => {
    settingsStore.save(raw);
    toast('Saved. The screener and portfolio use these values.');
  };
  const prodField = (p, key, label, step = 'any') =>
    h('td', {}, h('input', { type: 'number', step, 'aria-label': `${p.label} ${label}`, value: raw.products[p.id]?.[key] ?? p[key] ?? '', placeholder: p[key] ?? '', oninput: (e) => {
      raw.products[p.id] = { ...(raw.products[p.id] || {}) };
      if (e.target.value === '') delete raw.products[p.id][key];
      else raw.products[p.id][key] = Number(e.target.value);
    } }));

  root.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Settings'), h('p', {}, 'Your product catalog and modeling assumptions. Changes are saved in this browser. To change the defaults for everyone, edit data/products.json and data/global.json in the repository.'))),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Battery products'), h('span', { class: 'small muted' }, 'Footprint enables the space check; cost enables payback/NPV ranking')),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Product', 'kW', 'kWh', 'Installed cost ($/kWh)', 'Footprint incl. clearance (sq ft)', 'Notes'].map((t) => h('th', {}, t)))),
        h('tbody', {}, data.products.map((p) => h('tr', {},
          h('td', {}, h('strong', {}, p.label), h('div', { class: 'small muted' }, p.id)),
          h('td', {}, p.kw), h('td', {}, p.kwh),
          prodField(p, 'installed_cost_usd_per_kwh', 'cost'),
          prodField(p, 'footprint_sqft', 'footprint'),
          h('td', { class: 'small muted' }, p.notes || ''),
        ))),
      )),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Modeling assumptions')),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Assumption', 'Default', 'Your value', 'What it does', 'Source'].map((t) => h('th', {}, t)))),
        h('tbody', {}, (data.global.assumptions || []).map((a) => h('tr', {},
          h('td', {}, h('strong', {}, a.label || a.key), h('div', { class: 'small muted' }, a.key)),
          h('td', { class: 'num' }, String(a.value)),
          h('td', {}, typeof a.value === 'boolean'
            ? h('select', { onchange: (e) => { if (e.target.value === '') delete raw.assumptions[a.key]; else raw.assumptions[a.key] = e.target.value === 'true'; } }, [['', 'default'], ['true', 'true'], ['false', 'false']].map(([v, l]) => h('option', { value: v, selected: String(raw.assumptions[a.key] ?? '') === v }, l)))
            : h('input', { type: 'number', step: 'any', value: raw.assumptions[a.key] ?? '', placeholder: String(a.value), oninput: (e) => { if (e.target.value === '') delete raw.assumptions[a.key]; else raw.assumptions[a.key] = Number(e.target.value); } })),
          h('td', { class: 'small ink2' }, a.description || ''),
          h('td', { class: 'small muted' }, a.source || ''),
        ))),
      )),
    ),
    h('div', { class: 'btn-row', style: { marginTop: '14px' } },
      h('button', { class: 'btn primary', onclick: save }, 'Save settings'),
      h('button', { class: 'btn', onclick: () => { settingsStore.reset(); toast('Reset to defaults'); location.reload(); } }, 'Reset to defaults'),
    ),
  );
}
