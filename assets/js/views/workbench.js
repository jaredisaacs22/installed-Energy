// Workbench: the Site Analysis Workbench (peak-demand shaving model) hosted inside the Atlas.
// It is a self-contained page loaded in a same-origin iframe, so it runs exactly as the standalone file
// does (own state, own save/open, own print). Fonts and unit prices were removed — see docs/WORKBENCH.md.
import { h } from '../ui.js';

export const WORKBENCH_SRC = 'assets/workbench/workbench.html';

export function renderWorkbench(root) {
  root.append(
    h('div', { class: 'wb-bar' },
      h('div', {},
        h('span', { class: 'eyebrow' }, 'Peak-demand shaving model'),
        h('h1', {}, 'Site Analysis Workbench'),
        h('p', {}, 'Load a site’s interval data, size the battery against each month’s worst day, and review the dispatch. Save the site, then use ', h('a', { href: '#/screener' }, 'Site screener → Open site file'), ' to add incentives and tariffs.'),
      ),
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn small', href: WORKBENCH_SRC, target: '_blank', rel: 'noopener' }, 'Open full screen'),
      ),
    ),
    h('iframe', { class: 'wb-frame', src: WORKBENCH_SRC, title: 'Site Analysis Workbench' }),
    h('p', { class: 'small muted wb-note' }, 'Unit prices are not included in this copy, so units are ranked by savings rather than by cost. Work is saved in this browser by the workbench itself; use its Save button to keep a site file.'),
  );
}
