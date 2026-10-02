#!/usr/bin/env node
// Validates data/*.json: schema shape, cross-references, sources, confidence, staleness, and an engine smoke test.
// Usage: node scripts/validate-data.mjs [--max-age-days 180]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyzeSite } from '../assets/js/engine/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const CONFIDENCE = new Set(['high', 'medium', 'low']);
const STATUS = new Set(['open', 'waitlist', 'closed', 'paused', 'pending_launch', 'pilot']);
const METHODS = new Set(['per_kw_season', 'per_kw_month', 'per_kw_year', 'per_kwh_event', 'upfront_per_kwh', 'upfront_per_kw', 'pct_of_cost', 'per_mwh', 'text_only']);
const BASIS = new Set(['ncp_monthly', 'tou_window', 'daily', 'ratchet', 'contract', 'coincident']);

export function loadAll() {
  const manifest = read('data/manifest.json');
  return {
    manifest,
    products: read('data/products.json').products,
    global: read('data/global.json'),
    panel: read('data/panel.json'),
    jurisdictions: Object.fromEntries(manifest.jurisdictions.map((j) => [j.code, read(`data/jurisdictions/${j.file}`)])),
  };
}

export function validate(data, { maxAgeDays = 180, today = new Date() } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);
  const personaIds = new Set(data.panel.personas.map((p) => p.id));
  const ageDays = (d) => (d ? (today - new Date(d)) / 864e5 : Infinity);

  const checkSources = (where, obj) => {
    if (!Array.isArray(obj.sources) || !obj.sources.some((s) => s.url)) warn(`${where}: no source URL`);
  };
  const checkConf = (where, c) => {
    if (!CONFIDENCE.has(c)) err(`${where}: confidence "${c}" must be high|medium|low`);
  };

  for (const p of data.products) {
    if (!(p.kw > 0) || !(p.kwh > 0)) err(`product ${p.id}: kw/kwh must be > 0`);
    if (p.cost_is_placeholder) warn(`product ${p.id}: installed cost is a placeholder`);
  }

  const allProgramIds = new Set([...(data.global.programs || []).map((p) => p.id)]);
  for (const j of Object.values(data.jurisdictions)) (j.programs || []).forEach((p) => allProgramIds.add(p.id));

  const checkProgram = (where, p, utilIds) => {
    const w = `${where} program ${p.id}`;
    if (!STATUS.has(p.status)) err(`${w}: bad status "${p.status}"`);
    checkConf(w, p.confidence);
    checkSources(w, p);
    const v = p.valuation || {};
    if (!METHODS.has(v.method)) err(`${w}: bad valuation.method "${v.method}"`);
    if (v.method === 'pct_of_cost' && typeof v.rate === 'number' && v.rate > 1) err(`${w}: pct_of_cost rate must be a fraction (got ${v.rate})`);
    if (v.rate != null && typeof v.rate !== 'number') err(`${w}: rate must be number or null`);
    for (const u of p.utility_ids || []) if (utilIds && !utilIds.has(u)) err(`${w}: unknown utility_id ${u}`);
    for (const c of p.stacking?.conflicts_with || []) {
      if (!c.startsWith('cp:') && !allProgramIds.has(c)) err(`${w}: conflicts_with unknown program "${c}"`);
    }
    if (ageDays(p.last_verified) > maxAgeDays) warn(`${w}: last verified ${p.last_verified} (> ${maxAgeDays} days)`);
  };

  for (const [code, j] of Object.entries(data.jurisdictions)) {
    const where = `[${code}]`;
    for (const k of ['code', 'name', 'utilities', 'tariffs', 'programs', 'site_constraints']) if (!(k in j)) err(`${where}: missing ${k}`);
    if (ageDays(j.researched_on) > maxAgeDays) warn(`${where}: researched ${j.researched_on} (> ${maxAgeDays} days ago)`);
    const utilIds = new Set(j.utilities.map((u) => u.id));
    const ids = new Set();
    const uniq = (kind, id) => {
      if (ids.has(id)) err(`${where}: duplicate ${kind} id ${id}`);
      ids.add(id);
    };
    for (const t of j.tariffs) {
      const w = `${where} tariff ${t.id}`;
      uniq('tariff', t.id);
      if (!utilIds.has(t.utility_id)) err(`${w}: unknown utility_id ${t.utility_id}`);
      checkConf(w, t.confidence);
      checkSources(w, t);
      (t.demand_charges || []).forEach((dc, i) => {
        if (!BASIS.has(dc.basis)) err(`${w} demand #${i}: bad basis "${dc.basis}"`);
        if (dc.rate_usd_per_kw_month != null && typeof dc.rate_usd_per_kw_month !== 'number') err(`${w} demand #${i}: rate must be number|null`);
        if ((dc.basis === 'tou_window' || dc.basis === 'daily') && dc.rate_usd_per_kw_month != null && !dc.window) err(`${w} demand #${i}: ${dc.basis} needs a window`);
        if ((dc.months || []).some((m) => m < 1 || m > 12)) err(`${w} demand #${i}: months out of range`);
        if (dc.rate_usd_per_kw_month == null && dc.basis !== 'contract' && dc.basis !== 'coincident') warn(`${w}: "${dc.label}" has no verified rate`);
      });
      for (const cp of t.coincident_peak_charges || []) if (cp.est_value_usd_per_kw_year == null) warn(`${w}: peak tag "${cp.type}" has no value`);
    }
    for (const p of j.programs) {
      uniq('program', p.id);
      checkProgram(where, p, utilIds);
    }
    for (const c of j.site_constraints) {
      uniq('constraint', c.id);
      checkConf(`${where} constraint ${c.id}`, c.confidence);
      if (!c.rule_type) err(`${where} constraint ${c.id}: missing rule_type`);
    }
    for (const n of j.panel_notes || []) if (!personaIds.has(n.persona_id)) err(`${where}: panel note persona_id "${n.persona_id}" not in panel.json`);
  }
  for (const p of data.global.programs || []) checkProgram('[global]', p, null);
  for (const n of data.global.panel_notes || []) if (!personaIds.has(n.persona_id)) err(`[global]: panel note persona_id "${n.persona_id}" not in panel.json`);
  const keys = new Set();
  for (const a of data.global.assumptions || []) {
    if (keys.has(a.key)) err(`[global]: duplicate assumption ${a.key}`);
    keys.add(a.key);
  }

  // Engine smoke test: every tariff with a mid-size site must analyze to finite numbers.
  for (const [code, j] of Object.entries(data.jurisdictions)) {
    for (const t of j.tariffs) {
      const site = {
        jurisdiction: code, utility_id: t.utility_id, tariff_id: t.id, building_type: 'retail', peak_kw: 400, annual_kwh: 1_400_000,
        service_voltage: 480, phases: 3, service_amps: 1200, busbar_amps: 1200, main_breaker_amps: 1200,
        network_secondary: 'no', install_location: 'outdoor_ground', supply_contract: 'passthrough', energy_price: 0.15,
      };
      try {
        const a = analyzeSite(site, data);
        for (const r of a.results) {
          if (!Number.isFinite(r.totals.annual_base) || !Number.isFinite(r.totals.upfront_base)) err(`[${code}] ${t.id}: non-finite totals for ${r.config.id}`);
        }
      } catch (e) {
        err(`[${code}] ${t.id}: engine threw ${e.message}`);
      }
    }
  }
  return { errors, warnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--max-age-days');
  const maxAgeDays = i > 0 ? Number(process.argv[i + 1]) : 180;
  const { errors, warnings } = validate(loadAll(), { maxAgeDays });
  const quiet = process.argv.includes('--quiet');
  if (!quiet) for (const w of warnings) console.log(`warn  ${w}`);
  for (const e of errors) console.log(`ERROR ${e}`);
  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(errors.length ? 1 : 0);
}
