// Data health: what is verified, what is missing, and the audit trail of verification changes.
import { h, num, badge, confBadge } from '../ui.js';

const STALE_DAYS = 180;

export function renderHealth(root, data) {
  const markets = data.manifest.jurisdictions.map((m) => data.jurisdictions[m.code]);
  const today = new Date();
  const age = (d) => (d ? Math.round((today - new Date(d)) / 864e5) : null);

  // Missing tariff elements
  const missing = [];
  for (const j of markets) {
    for (const t of j.tariffs || []) {
      const util = j.utilities.find((u) => u.id === t.utility_id);
      (t.demand_charges || []).forEach((d) => {
        if (d.basis === 'contract' || d.basis === 'coincident') return;
        if (typeof d.rate_usd_per_kw_month !== 'number') missing.push({ market: j.code, util: util?.name || t.utility_id, tariff: t.name, item: d.label, kind: 'Demand charge', source: t.sources?.[0], note: d.notes || '' });
      });
      (t.coincident_peak_charges || []).forEach((c) => {
        if (typeof c.est_value_usd_per_kw_year !== 'number') missing.push({ market: j.code, util: util?.name || t.utility_id, tariff: t.name, item: `Peak tag (${c.type})`, kind: 'Peak tag', source: t.sources?.[0], note: c.derivation || c.how_set || '' });
      });
    }
  }
  // Low-confidence values in active use
  const lowConf = [];
  for (const j of markets) {
    for (const p of j.programs || []) {
      const active = ['open', 'pilot', 'waitlist', 'pending_launch'].includes(p.status) && typeof p.valuation?.rate === 'number' && p.valuation.method !== 'text_only';
      if (active && p.confidence === 'low') {
        lowConf.push({ market: j.code, name: p.name, kind: 'Program', value: `${p.valuation.rate} ${p.valuation.unit || ''}`, source: p.sources?.[0], note: p.verification_notes || '' });
      } else if (active && p.valuation.value_confidence === 'low') {
        lowConf.push({ market: j.code, name: p.name, kind: 'Program estimate', value: `${p.valuation.rate} ${p.valuation.unit || ''} × ${p.valuation.expected_event_hours_per_year ?? '?'} event-h/yr`, source: p.sources?.[0], note: p.valuation.value_confidence_notes || '' });
      }
    }
    for (const t of j.tariffs || []) {
      const anyPriced = (t.demand_charges || []).some((d) => typeof d.rate_usd_per_kw_month === 'number');
      if (anyPriced && t.confidence === 'low') lowConf.push({ market: j.code, name: t.name, kind: 'Tariff', value: 'demand charges', source: t.sources?.[0], note: t.verification_notes || '' });
    }
  }
  const conf = { high: 0, medium: 0, low: 0 };
  let programs = 0;
  for (const j of markets) for (const p of j.programs || []) (programs++, (conf[p.confidence] = (conf[p.confidence] || 0) + 1));
  const charges = markets.flatMap((j) => (j.tariffs || []).flatMap((t) => t.demand_charges || [])).filter((d) => d.basis !== 'contract' && d.basis !== 'coincident');
  const priced = charges.filter((d) => typeof d.rate_usd_per_kw_month === 'number').length;
  const openQ = markets.reduce((n, j) => n + (j.open_questions || []).length, 0);
  const log = data.verification_log?.entries || [];

  const srcLink = (s) => (s?.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.title ? truncate(s.title, 48) : 'source') : h('span', { class: 'muted' }, '—'));

  root.append(
    h('div', { class: 'page-head' }, h('div', {}, h('div', { class: 'eyebrow' }, 'Accuracy'), h('h1', {}, 'Data health'), h('p', {}, 'What is verified, what is missing, and every change made during verification. Missing values are excluded from savings, never guessed. Fill the high-impact gaps first.'))),
    h('div', { class: 'kpis', style: { gridTemplateColumns: 'repeat(4, minmax(0,1fr))', marginBottom: '16px' } },
      kpi('Demand-charge rates verified', `${charges.length ? Math.round((100 * priced) / charges.length) : 100}%`, `${priced} of ${charges.length} elements`),
      kpi('Program confidence', `${conf.high} / ${conf.medium} / ${conf.low}`, `high / medium / low of ${programs}`),
      kpi('Gaps to fill', num(missing.length), 'tariff elements without a rate'),
      kpi('Research date', data.manifest.updated, `${openQ} open questions logged`),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'By market')),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Market', 'Researched', 'Age (days)', 'Rate coverage', 'Programs (H/M/L)', 'Gaps', 'Open questions'].map((t, i) => h('th', { class: i > 1 ? 'num' : '' }, t)))),
        h('tbody', {}, markets.map((j) => {
          const ch = (j.tariffs || []).flatMap((t) => t.demand_charges || []).filter((d) => d.basis !== 'contract' && d.basis !== 'coincident');
          const pr = ch.filter((d) => typeof d.rate_usd_per_kw_month === 'number').length;
          const c = { high: 0, medium: 0, low: 0 };
          (j.programs || []).forEach((p) => (c[p.confidence] = (c[p.confidence] || 0) + 1));
          const a = age(j.researched_on);
          return h('tr', {},
            h('td', {}, h('strong', {}, j.name)),
            h('td', {}, j.researched_on || '—'),
            h('td', { class: 'num' }, a == null ? '—' : a > STALE_DAYS ? badge(`${a} — stale`, 'caution') : num(a)),
            h('td', { class: 'num' }, ch.length ? `${Math.round((100 * pr) / ch.length)}%` : '—'),
            h('td', { class: 'num' }, `${c.high}/${c.medium}/${c.low}`),
            h('td', { class: 'num' }, num(missing.filter((m) => m.market === j.code).length)),
            h('td', { class: 'num' }, num((j.open_questions || []).length)),
          );
        })),
      )),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Gaps to fill'), h('span', { class: 'small muted' }, 'Enter these from the customer bill in the screener’s Rate panel, or update data/jurisdictions/*.json')),
      missing.length
        ? h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['Market', 'Utility / tariff', 'Element', 'Note', 'Where to check'].map((t) => h('th', {}, t)))),
            h('tbody', {}, missing.map((m) => h('tr', {}, h('td', {}, m.market), h('td', { class: 'small' }, h('div', {}, m.util), h('div', { class: 'muted' }, m.tariff)), h('td', {}, m.item), h('td', { class: 'small ink2' }, truncate(m.note, 160)), h('td', { class: 'small' }, srcLink(m.source))))),
          ))
        : h('p', { class: 'muted' }, 'No gaps — every tariff element has a rate.'),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Low-confidence values in use'), h('span', { class: 'small muted' }, 'Counted in results, but from a single secondary source — verify before investment decisions')),
      lowConf.length
        ? h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['Market', 'Item', 'Type', 'Value', 'Note', 'Source'].map((t) => h('th', {}, t)))),
            h('tbody', {}, lowConf.map((m) => h('tr', {}, h('td', {}, m.market), h('td', {}, m.name), h('td', {}, m.kind), h('td', { class: 'small' }, m.value), h('td', { class: 'small ink2' }, truncate(m.note, 160)), h('td', { class: 'small' }, srcLink(m.source))))),
          ))
        : h('p', { class: 'muted' }, 'None.'),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Verification log'), h('span', { class: 'small muted' }, 'Changes made by the verification panel, with evidence')),
      log.length
        ? h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['Date', 'Market', 'Item', 'Change', 'Confidence', 'Evidence', 'Source'].map((t) => h('th', {}, t)))),
            h('tbody', {}, log.map((e) => h('tr', {},
              h('td', { class: 'small' }, e.date),
              h('td', {}, e.market),
              h('td', { class: 'small' }, e.item),
              h('td', { class: 'small' }, e.action === 'confirmed' ? badge('confirmed', 'ok') : h('span', {}, `${fmtVal(e.old)} → `, h('strong', {}, fmtVal(e.new)))),
              h('td', {}, confBadge(e.confidence)),
              h('td', { class: 'small ink2' }, truncate(e.evidence || '', 200)),
              h('td', { class: 'small' }, srcLink(e.sources?.[0])),
            ))),
          ))
        : h('p', { class: 'muted' }, 'No verification changes recorded yet.'),
    ),
  );
}

const kpi = (label, value, sub) => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub));
const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const fmtVal = (v) => (v == null ? 'null' : typeof v === 'object' ? 'object' : String(v));
