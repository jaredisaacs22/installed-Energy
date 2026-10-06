#!/usr/bin/env node
// Builds assets/workbench/workbench.html from the Site Analysis Workbench source file.
//
// This repository and its GitHub Pages site are publicly readable and the Atlas sign-in gate is
// client-side only, so two things in the source file must not be published:
//   1. the embedded DIN Pro font files (licensed typeface), and
//   2. unit prices (catalog costs, install/battery/capex defaults, price quotes in help text).
// Everything else is left byte-for-byte as the source. Every edit below asserts that it matched,
// so a changed source file fails loudly instead of silently shipping a price.
//
// Usage: node scripts/scrub-workbench.mjs <source.html> [out.html]
//        (default out: assets/workbench/workbench.html)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT = join(ROOT, 'assets', 'workbench', 'workbench.html');

// Fixture amounts the scrubbed self-tests use in place of the original price-derived ones.
// (None may equal a removed price, or the leak check below would flag it.)
const FX = { battery: 120000, capex: 170000, residual5: 80000, fedYr1: 28560, state: 1502.8, fedBasis: 136000 };
const usd = (n) => n.toLocaleString('en-US');

/** Replace every match of `re`, asserting the number of matches (default: at least one). */
function sub(html, name, re, to, { exactly, min = 1 } = {}) {
  let n = 0;
  const out = html.replace(re, (...m) => {
    n++;
    if (typeof to === 'function') return to(...m);
    const groups = m.length - 3; // (match, ...captures, offset, string)
    // Expand $1..$n only for real capture groups, so a literal "$25,200" in the text stays literal.
    return to.replace(/\$([1-9])/g, (all, i) => (+i <= groups ? m[+i] : all));
  });
  if (exactly != null ? n !== exactly : n < min) throw new Error(`scrub: "${name}" matched ${n} time(s), expected ${exactly != null ? exactly : `at least ${min}`}`);
  return { html: out, n };
}

/** Numbers that the source file uses as prices; used only to prove none survive the scrub. */
export function collectPrices(src) {
  const found = new Set();
  const add = (v) => {
    if (+v >= 1000) found.add(String(+v));
  };
  for (const m of src.matchAll(/\b(?:cost|costTrailer|batteryCost|installCost|capexUSD)\s*:\s*(\d+(?:\.\d+)?)/g)) add(m[1]);
  return found;
}

/** Structural checks that need no knowledge of the actual prices. Returns a list of problems. */
export function findProprietary(html) {
  const problems = [];
  if (/data:font\//i.test(html)) problems.push('embedded font data URI');
  if (/@font-face/i.test(html)) problems.push('@font-face rule');
  const units = html.match(/var UNITS=\[[\s\S]*?\n\];/);
  if (!units) problems.push('UNITS catalog not found');
  else {
    if (/\bcost\s*:\s*\d/.test(units[0])) problems.push('numeric unit cost in UNITS');
    if (/costTrailer/.test(units[0])) problems.push('costTrailer in UNITS');
  }
  const econ = html.match(/function blankEconomics\(\)\{return \{[\s\S]*?\};\}/);
  if (!econ) problems.push('blankEconomics not found');
  else for (const k of ['batteryCost', 'installCost', 'capexUSD', 'omUSD']) if (!new RegExp(`${k}\\s*:\\s*0\\s*[,}\\s]`).test(econ[0])) problems.push(`blankEconomics.${k} is not 0`);
  if (/SZ_UNITS\.push\(\{[^}]*\bcost\s*:\s*\d/.test(html)) problems.push('numeric default cost for a new unit');
  if (/\bDefault \$\d/.test(html)) problems.push('install-cost price note in help text');
  if (/Typical range \$[\d,]+/.test(html)) problems.push('O&M price range in help text');
  return problems;
}

export function scrub(src) {
  let html = src;
  const report = [];
  const run = (name, re, to, opts) => {
    const r = sub(html, name, re, to, opts);
    html = r.html;
    report.push(`${name} (${r.n})`);
  };

  // 1. Fonts: drop the embedded DIN Pro files; the CSS font stacks already fall back to Segoe UI / Arial.
  run('remove embedded @font-face rules', /@font-face\s*\{[^}]*data:font\/[^}]*\}[ \t]*\n?/g, '', { exactly: 4 });
  run('font comment', /\/\* =+ Brand type: DIN Pro, embedded[^*]*\*\//, "/* Brand type: DIN Pro is used when installed on the viewer's machine. The licensed font files are not published in the Atlas build; the stacks below fall back to system fonts. */");

  // 2. Unit catalog: rewrite comments that quote or point at price sources, then blank every price.
  run('catalog comment: skid/trailer cost', /cost = skid\/trailer base; costTrailer = trailer-mounted option where available\./, 'cost = unit price (removed in the Atlas build; enter prices in the unit editor).');
  run('catalog comment: RPS1200 source', /from the SCI RPS1200 pro forma 2026-08/, 'from a vendor pro forma (2026-08)');
  run('catalog comment: RPS1200 cost', /cost = the SCI pro forma's bundled equipment figure \(RPS1200 \+ PWD-300-ATS \+ EMS box\);\s*verify per deal\./, 'cost = unit price (removed in the Atlas build).');
  run('catalog comment: opportunity name', /larger sites, e\.g\.\s*the GA Power UPS opportunity\)/, 'larger sites)');
  run('catalog comment: placeholder price', /cost:\d+ is a placeholder figure \(Jared, 2026-09-23\) — verify per deal before quoting\./, 'Unit price removed in the Atlas build; enter it in the unit editor.');
  const cat = html.match(/var UNITS=\[[\s\S]*?\n\];/);
  if (!cat) throw new Error('scrub: UNITS catalog not found');
  let blanked = 0;
  const catScrubbed = cat[0].replace(/\bcostTrailer\s*:\s*\d+(?:\.\d+)?\s*,\s*/g, '').replace(/\bcost\s*:\s*\d+(?:\.\d+)?/g, () => {
    blanked++;
    return 'cost:null';
  });
  if (blanked < 1) throw new Error('scrub: no numeric unit costs found in UNITS');
  html = html.replace(cat[0], () => catScrubbed);
  report.push(`blank catalog unit prices (${blanked}) and trailer prices`);

  // 3. Economics defaults and the default price of a newly added unit.
  run('blankEconomics battery/install/capex defaults', /batteryCost:\d+,\s*installCost:\d+,\s*capexUSD:\d+,/, 'batteryCost:0, installCost:0, capexUSD:0,', { exactly: 1 });
  run('blankEconomics O&M default', /(function blankEconomics\(\)\{return \{[\s\S]*?)omUSD:\d+,/, '$1omUSD:0,', { exactly: 1 });
  run('new-unit default price', /(SZ_UNITS\.push\(\{[^}]*?effD:0\.94,)cost:\d+\}/, '$1cost:null}', { exactly: 1 });

  // 4. Help text that quotes prices.
  run('help text: install cost note', /Default \$65k — adjust per site quote/, 'Adjust per site quote', { exactly: 1 });
  run('help text: O&M range', /Typical range \$3,000–5,000\/yr for an RPSLinkEX unit\./, "Enter the annual service-contract figure for the unit.", { exactly: 1 });

  // 5. Self-test fixtures that were built on the real battery price: use neutral round fixtures instead.
  run('selftest: cashflow override fixture', /buildCashflows\(\{benefit:5207,batteryCost:\d+\}\)/, `buildCashflows({benefit:5207,batteryCost:${FX.battery}})`, { exactly: 1 });
  run('selftest: cashflow override expectation', /bcOv\.rows\[0\]\.net===-\d+/, `bcOv.rows[0].net===-(${FX.battery}+(+model.economics.installCost||0))`, { exactly: 1 });
  run('selftest: depreciation capex fixture', /model\.economics\.capexUSD=\d+; model\.economics\.itcPct=0\.40;/, `model.economics.capexUSD=${FX.capex}; model.economics.itcPct=0.40;`, { exactly: 1 });
  run('selftest: fed yr-1', /t\("depreciation fed yr-1 \$[\d,]+", Math\.abs\(d\.fedYr1-\d+\)<5/, `t("depreciation fed yr-1 $${usd(FX.fedYr1)}", Math.abs(d.fedYr1-${FX.fedYr1})<5`, { exactly: 1 });
  run('selftest: state annual', /t\("depreciation state \$[\d,]+\/yr", Math\.abs\(d\.stateAnnual-[\d.]+\)<2/, `t("depreciation state $${usd(Math.round(FX.state))}/yr", Math.abs(d.stateAnnual-${FX.state})<2`, { exactly: 1 });
  run('selftest: fed basis', /(t\("fed basis = capex - 1\/2 ITC", Math\.abs\(d\.fedBasis-)\d+\)<5/, `$1${FX.fedBasis})<5`, { exactly: 1 });
  run('selftest: residual battery fixture', /model\.economics\.batteryCost=\d+; model\.economics\.batteryLifeYrs=15;/, `model.economics.batteryCost=${FX.battery}; model.economics.batteryLifeYrs=15;`, { exactly: 1 });
  run('selftest: residual expectation', /Math\.round\(\(1-5\/15\)\*\d+\); \/\* = [\d,]+ \*\//, `Math.round((1-5/15)*${FX.battery}); /* = ${usd(FX.residual5)} */`, { exactly: 1 });
  run('selftest: residual label', /t\("residual 5-yr = \$[\d,]+ \(10\/15 of battery\)"/, `t("residual 5-yr = $${usd(FX.residual5)} (10/15 of battery)"`, { exactly: 1 });
  run('selftest: placeholder price note', /\(added 2026-09-23, \$[\d,]+ placeholder price\)/, '(added 2026-09-23, lowest-priced feasible unit in the original catalog)', { exactly: 1 });
  run('selftest: heads-up line', /(function runSelfTests\(\)\{\n)/, '$1  if(UNITS.every(function(u){return u.cost==null;}))console.log("Atlas build: catalog prices were removed, so self-tests that rank units by price are expected to fail. Run the original workbench file for the full suite.");\n', { exactly: 1 });

  // 6. Provenance banner.
  run('provenance banner', /^<!doctype html>\n/i, '<!doctype html>\n<!-- Atlas build of the Site Analysis Workbench. Generated by scripts/scrub-workbench.mjs: embedded DIN Pro fonts and unit prices removed; see docs/WORKBENCH.md. Do not edit by hand. -->\n', { exactly: 1 });

  const prices = collectPrices(src);
  const leaked = [...prices].filter((p) => new RegExp(`(^|[^\\d.])(${p}|${Number(p).toLocaleString('en-US')})(?![\\d])`).test(html));
  if (leaked.length) throw new Error(`scrub: price figure(s) still present in the output (${leaked.length}); refusing to write it`);
  const problems = findProprietary(html);
  if (problems.length) throw new Error(`scrub: output still contains: ${problems.join('; ')}`);
  return { html, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [src, out = DEFAULT_OUT] = process.argv.slice(2);
  if (!src) {
    console.error('Usage: node scripts/scrub-workbench.mjs <source.html> [out.html]');
    process.exit(2);
  }
  const { html, report } = scrub(readFileSync(src, 'utf8'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB, source ${(readFileSync(src).length / 1024).toFixed(0)} KB)`);
  for (const line of report) console.log(`  - ${line}`);
}
