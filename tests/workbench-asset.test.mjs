// Guards for the hosted Site Analysis Workbench (assets/workbench/workbench.html).
// The repository and Pages site are public, so the published copy must carry no embedded fonts or unit prices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { findProprietary, scrub } from '../scripts/scrub-workbench.mjs';
import { injectAddon, readAddon, embeddedEnv } from '../scripts/workbench-addon.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const html = read('assets/workbench/workbench.html');

test('workbench asset: no embedded fonts or unit prices are published', () => {
  assert.deepEqual(findProprietary(html), []);
});

test('workbench asset: catalog units are price-less and economics defaults are zero', () => {
  const catalog = html.match(/var UNITS=\[[\s\S]*?\n\];/)[0];
  const units = [...catalog.matchAll(/\{id:"([^"]+)"[^}]*?cost:(null|\d+)/g)];
  assert.ok(units.length >= 6, 'catalog parsed');
  assert.ok(units.every((m) => m[2] === 'null'), 'every catalog unit has cost:null');
  const econ = html.match(/function blankEconomics\(\)\{return \{[\s\S]*?\};\}/)[0];
  for (const k of ['batteryCost', 'installCost', 'capexUSD', 'omUSD']) assert.match(econ, new RegExp(`${k}:0[,\\s]`), `${k} default is 0`);
});

test('workbench asset: findProprietary flags what it exists to catch', () => {
  assert.ok(findProprietary(html.replace('cost:null', 'cost:12345')).some((p) => /unit cost/.test(p)));
  assert.ok(findProprietary(html.replace('<style>', '<style>@font-face{src:url(data:font/otf;base64,AAAA)}')).some((p) => /font/.test(p)));
  assert.ok(findProprietary(html.replace('batteryCost:0', 'batteryCost:9999')).some((p) => /batteryCost/.test(p)));
});

test('workbench asset: scrub refuses a source it does not recognise', () => {
  assert.throws(() => scrub('<!doctype html>\n<html></html>'), /scrub:/);
});

test('workbench asset: is self-contained (no external scripts, styles, fonts or fetches)', () => {
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=["']?https?:/i);
  assert.doesNotMatch(html, /@import|\bfetch\(|XMLHttpRequest|sendBeacon/);
});

test('workbench asset: keeps the three workbench tabs and its self-test entry point', () => {
  assert.match(html, /\{id:"interval", label:"Interval Data"\}/);
  assert.match(html, /\{id:"sizing",\s+label:"Sizing"\}/);
  assert.match(html, /\{id:"displace", label:"Energy Displacement"\}/);
  assert.match(html, /function runSelfTests\(\)\{/);
});

test('workbench asset: carries the current add-on and the committed encrypted price book', () => {
  assert.equal(injectAddon(html, readAddon()), html, 'out of date: run node scripts/workbench-addon.mjs');
  assert.deepEqual(embeddedEnv(html), JSON.parse(read('assets/workbench/pricebook.enc.json')));
  for (const m of ['/* ATLAS-ADDON:BEGIN', '/* ATLAS-ADDON:END */', '/* ATLAS-ADDON-CSS:BEGIN', '/* ATLAS-ADDON-CSS:END */']) assert.equal(html.split(m).length, 2, `one ${m}`);
  assert.ok(html.indexOf('/* ATLAS-ADDON:END */') < html.indexOf('/* ============================ Init ============================ */'), 'add-on runs before Init');
});

test('workbench asset: the locked build stays kW-only and the add-on hooks are in place', () => {
  assert.match(html, /function modeBar\(\)\{\n  if\(!FIN\.on\)return '';/);
  assert.match(html, /model\.tariffs\.mode="peak-shave";[^\n]*\n/, 'new sites still start in peak-shave mode');
  assert.match(html, /finKwOnly\(\);\}   \/\* Atlas build/);
  assert.match(html, /if\(finKwOnly\(\)\)\{try\{computeSizing\(\);\}catch\(e2\)\{\}\}/);
  assert.match(html, /var TABS=\[\n  \{id:"interval"[^\n]*\n  \{id:"sizing"[^\n]*\n  \{id:"displace"[^\n]*\n\];/, 'only the three kW tabs until unlocked');
  // the add-on unlocks only through the price book: no plaintext price, no key, no network
  const addon = html.slice(html.indexOf('/* ATLAS-ADDON:BEGIN'), html.indexOf('/* ATLAS-ADDON:END */'));
  assert.match(addon, /crypto\.subtle\.decrypt/);
  assert.doesNotMatch(addon.replace(/var FIN_ENV=[^\n]*\n/, ''), /\b\d{5,}\b/, 'no price-sized figures in the add-on code');
});

test('workbench tab is wired into the app, nav and Pages build', () => {
  assert.match(read('index.html'), /href="#\/workbench" data-route="workbench"/);
  assert.match(read('assets/js/app.js'), /workbench: renderWorkbench/);
  assert.match(read('assets/js/views/workbench.js'), /assets\/workbench\/workbench\.html/);
  assert.match(read('.github/workflows/pages.yml'), /\bassets\b/);
});
