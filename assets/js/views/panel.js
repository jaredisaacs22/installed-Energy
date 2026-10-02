// Expert panel page: persona roster, market briefings per jurisdiction.
import { h, initials } from '../ui.js';
import { noteEl } from './screener.js';

export function renderPanel(root, data, params) {
  let market = params.get('market') || data.manifest.jurisdictions[0].code;
  const personas = data.panel.personas || [];
  const byId = Object.fromEntries(personas.map((p) => [p.id, p]));
  const host = h('div', {});
  root.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Expert panel'), h('p', {}, data.panel.disclaimer || ''))),
    h('div', { class: 'lib-grid', style: { marginBottom: '18px' } }, personas.map((p) => h('div', { class: 'prog' },
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, h('div', { class: `avatar ${p.kind === 'utility' ? 'utility' : 'specialist'}` }, p.initials || initials(p.name)), h('div', {}, h('h3', { style: { margin: 0 } }, p.name), h('div', { class: 'small muted' }, `${p.role}${p.jurisdictions?.length ? ' · ' + p.jurisdictions.join(', ') : ' · all markets'}`))),
      h('p', { class: 'small ink2', style: { marginTop: '8px' } }, p.lens),
      p.challenges?.length ? h('ul', { class: 'small ink2', style: { margin: '4px 0 0', paddingLeft: '18px' } }, p.challenges.map((c) => h('li', {}, c))) : null,
    ))),
    host,
  );
  function draw() {
    const j =
      market === 'FEDERAL'
        ? { name: 'Codes & federal', summary: data.global.summary, researched_on: data.global.researched_on, panel_notes: data.global.panel_notes, open_questions: data.global.open_questions }
        : data.jurisdictions[market];
    const notes = (j.panel_notes || []).map((n) => ({ persona: n.persona_id, severity: n.severity || 'info', title: n.topic, text: n.note, src: 'briefing' }));
    const order = { critical: 0, caution: 1, info: 2 };
    notes.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    host.replaceChildren(
      h('div', { class: 'tabs-inline' }, [...data.manifest.jurisdictions, { code: 'FEDERAL', name: 'Codes & federal' }].map((m) => h('button', { 'aria-selected': m.code === market ? 'true' : 'false', onclick: () => { market = m.code; draw(); } }, m.name))),
      h('div', { class: 'cols-2' },
        h('div', { class: 'card' }, h('h2', {}, `${j.name}: market briefing`), h('p', { class: 'ink2' }, j.summary || ''), h('p', { class: 'small muted' }, `Researched ${j.researched_on || '—'}. ${j.data_notes || ''}`),
          (j.open_questions || []).length ? h('details', {}, h('summary', { class: 'small', style: { cursor: 'pointer', fontWeight: 600 } }, `Open questions to verify (${j.open_questions.length})`), h('ul', { class: 'small ink2' }, j.open_questions.map((q) => h('li', {}, q)))) : null,
        ),
        h('div', { class: 'card' }, h('h2', {}, 'Panel notes'), notes.length ? notes.map((n) => noteEl(n, byId[n.persona])) : h('p', { class: 'muted' }, 'No notes yet.')),
      ),
    );
  }
  draw();
}
