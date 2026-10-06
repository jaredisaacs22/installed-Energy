// App bootstrap: load data, route between views, persist settings.
import { h, storage } from './ui.js';
import { renderScreener } from './views/screener.js';
import { renderPortfolio } from './views/portfolio.js';
import { renderLibrary } from './views/library.js';
import { renderPanel } from './views/panel.js';
import { renderMethod } from './views/method.js';
import { renderSettings } from './views/settings.js';
import { renderOverview } from './views/overview.js';
import { renderHealth } from './views/health.js';
import { renderWorkbench } from './views/workbench.js';
import { requireSignIn, signOut } from './access.js';
import { intervalStore } from './interval-store.js';

const app = document.getElementById('app');

async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export async function loadData() {
  const manifest = await loadJson('data/manifest.json');
  const [products, global, panel] = await Promise.all([loadJson('data/products.json'), loadJson('data/global.json'), loadJson('data/panel.json')]);
  const jurisdictions = {};
  await Promise.all(
    manifest.jurisdictions.map(async (j) => {
      jurisdictions[j.code] = await loadJson(`data/jurisdictions/${j.file}`);
    }),
  );
  const verification_log = await loadJson('data/verification-log.json').catch(() => null);
  return { manifest, products: products.products, global, panel, jurisdictions, verification_log };
}

/** Settings = user overrides of products & assumptions, stored per browser. */
export const settingsStore = {
  get(data) {
    const saved = storage.get('atlas.settings', {});
    const products = data.products.map((p) => ({ ...p, ...(saved.products?.[p.id] || {}) }));
    return { assumptions: saved.assumptions || {}, products, raw: saved };
  },
  save(raw) {
    storage.set('atlas.settings', raw);
  },
  reset() {
    storage.del('atlas.settings');
  },
};

const routes = {
  overview: renderOverview,
  screener: renderScreener,
  workbench: renderWorkbench,
  health: renderHealth,
  portfolio: renderPortfolio,
  library: renderLibrary,
  panel: renderPanel,
  method: renderMethod,
  settings: renderSettings,
};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { route: routes[path] ? path : 'overview', params: new URLSearchParams(query) };
}

let DATA = null;
const TITLES = { overview: 'Overview', screener: 'Site screener', workbench: 'Workbench', portfolio: 'Portfolio', library: 'Programs & tariffs', health: 'Data health', panel: 'Expert panel', method: 'Methodology', settings: 'Settings' };

async function render() {
  const { route, params } = parseHash();
  document.querySelectorAll('[data-route]').forEach((a) => a.setAttribute('aria-current', a.dataset.route === route ? 'page' : 'false'));
  document.title = `${TITLES[route] || 'BESS Incentive Atlas'} · BESS Incentive Atlas`;
  app.replaceChildren();
  app.classList.toggle('wide', route === 'workbench');
  try {
    routes[route](app, DATA, params);
  } catch (err) {
    console.error(err);
    app.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Something went wrong'), h('pre', {}, String(err.stack || err))));
  }
  window.scrollTo({ top: 0 });
}

// Light theme only (white background); clear any theme saved by earlier versions.
function initTheme() {
  document.documentElement.removeAttribute('data-theme');
  storage.del('atlas.theme');
}

(async function main() {
  initTheme();
  const session = await requireSignIn(app);
  const who = document.getElementById('signed-in');
  who.replaceChildren(h('span', { class: 'email' }, session.email), h('button', { class: 'icon-btn', type: 'button', title: `Signed in as ${session.email}`, onclick: signOut }, 'Sign out'));
  try {
    DATA = await loadData();
    await intervalStore.init(); // imported workbench interval data (IndexedDB); never throws
    document.getElementById('data-version').textContent = ` Data version ${DATA.manifest.data_version} (updated ${DATA.manifest.updated}).`;
  } catch (err) {
    app.replaceChildren(
      h('div', { class: 'card' }, h('h2', {}, 'Could not load data'), h('p', {}, String(err)), h('p', { class: 'muted' }, 'If you opened index.html directly from disk, serve the folder instead (e.g. `python3 -m http.server`) — browsers block fetch() on file:// URLs.')),
    );
    return;
  }
  window.addEventListener('hashchange', render);
  render();
})();
