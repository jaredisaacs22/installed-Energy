// Tiny DOM helpers and formatters (no framework).

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const svgNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export const usd = (x, opts = {}) => {
  if (x == null || !Number.isFinite(x)) return '—';
  const abs = Math.abs(x);
  if (opts.compact && abs >= 1e6) return `${x < 0 ? '−' : ''}$${(abs / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`;
  if (opts.compact && abs >= 1e4) return `${x < 0 ? '−' : ''}$${(abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
  return `${x < 0 ? '−' : ''}$${Math.round(abs).toLocaleString('en-US')}`;
};
export const num = (x, d = 0) => (x == null || !Number.isFinite(x) ? '—' : x.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
export const yrs = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x.toFixed(1)} yr`);
export const pct = (x) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(1)}%`);

const SEV_PATHS = {
  ok: 'M5 12l4 4 10-10',
  info: 'M12 8h.01M11 12h1v5h1',
  caution: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  critical: 'M12 3l9 9-9 9-9-9zM12 8v5M12 16h.01',
};
export function sevIcon(sev) {
  const svg = s('svg', { class: 'sev-icon', viewBox: '0 0 24 24', fill: 'none', stroke: sevColor(sev), 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  if (sev === 'info' || sev === 'ok') svg.append(s('circle', { cx: 12, cy: 12, r: 9.5, 'stroke-width': 1.8 }));
  svg.append(s('path', { d: SEV_PATHS[sev] || SEV_PATHS.info }));
  return svg;
}
export const sevColor = (sev) => ({ ok: 'var(--good)', info: 'var(--s1)', caution: 'var(--warning)', critical: 'var(--critical)' })[sev] || 'var(--muted)';
export const SEV_LABEL = { ok: 'OK', info: 'Info', caution: 'Caution', critical: 'Critical' };

export function badge(text, cls = '') {
  return h('span', { class: `badge ${cls}` }, text);
}
export function sevBadge(sev) {
  return h('span', { class: `badge ${sev}` }, sevIcon(sev), SEV_LABEL[sev] || sev);
}
export function confBadge(c) {
  return c ? h('span', { class: `badge ${c}`, title: 'Data confidence' }, `${c} confidence`) : null;
}

export function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

export const storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode / quota — ignore */
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/** Tooltip singleton. */
let tipEl = null;
export function showTip(evt, title, lines) {
  if (!tipEl) {
    tipEl = h('div', { class: 'tooltip', role: 'tooltip' });
    document.body.append(tipEl);
  }
  tipEl.replaceChildren(h('div', { class: 't' }, title), ...lines.map((l) => h('div', {}, l)));
  tipEl.style.display = 'block';
  const pad = 14;
  const { innerWidth: W, innerHeight: H } = window;
  const r = tipEl.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > W - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > H - 8) y = evt.clientY - r.height - pad;
  tipEl.style.left = `${Math.max(8, x)}px`;
  tipEl.style.top = `${Math.max(8, y)}px`;
}
export function hideTip() {
  if (tipEl) tipEl.style.display = 'none';
}

export function initials(name) {
  return String(name || '?')
    .replace(/\(.*?\)/g, '')
    .split(/[\s&/-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export function sourcesList(sources) {
  if (!sources?.length) return null;
  return h(
    'div',
    { class: 'sources' },
    h('span', { class: 'muted' }, 'Sources: '),
    sources.map((src, i) => [i ? ' · ' : '', src.url ? h('a', { href: src.url, target: '_blank', rel: 'noopener' }, src.title || src.url) : src.title]),
  );
}
