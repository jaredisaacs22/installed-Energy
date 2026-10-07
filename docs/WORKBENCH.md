# Site Analysis Workbench (the Workbench tab)

The **Workbench** tab hosts the Site Analysis Workbench, the single-file peak-demand shaving model, inside the Atlas. It loads `assets/workbench/workbench.html` in a same-origin iframe, so it behaves exactly like the standalone file: its own Interval Data / Sizing / Energy Displacement tabs, its own **Open / Save / Print**, and its own browser autosave (`sie_nofin`). **Open full screen** opens the same page in its own tab.

The Atlas does not change the model's math. The workbench still exchanges `<site>-site.json` files with the Site screener (see [EXPORT-SCHEMA.md](EXPORT-SCHEMA.md)): save the site in the Workbench, then **Site screener → Open site file**.

## What was removed, and why

The repository and the GitHub Pages site are publicly readable, and the sign-in gate is client-side only ([ACCESS.md](ACCESS.md)). Anything committed under `assets/` can be fetched by URL, so two things in the original file are **not** published:

| Removed | Replaced with |
|---|---|
| The four embedded DIN Pro font files (`@font-face` data URIs) | Nothing. The CSS font stacks are unchanged (`"DIN Pro", "Segoe UI", Arial, …`), so DIN Pro is used on machines where it is installed and a system font everywhere else. |
| Unit prices: every `cost` in the `UNITS` catalog and the trailer option price | `cost:null`. The catalog already supports price-less units (the 2.5 MW unit shipped that way). |
| Default battery, install, capex and O&M amounts in `blankEconomics()` | `0` |
| The default price of a newly added unit type | `null` |
| Help text that quoted an install-cost default and an O&M price range | Neutral wording |
| Code comments naming a specific customer opportunity and a vendor pro forma | Generic wording |
| Self-test fixtures that were built on the real battery price | Round fixture amounts, with the expected values recomputed |

Everything else is byte-for-byte the source file, plus a provenance comment at the top and one console hint at the start of `runSelfTests()`.

## What behaves differently without prices

- **Interval data, peak-shave mode (the default workflow):** the recommended system, the per-month sustainable holds and every candidate's savings matched the original on the four synthetic sites compared. Candidates that are not recommended are ordered by savings instead of by cost, because there is no cost to break ties.
- **Billing modes without interval data (bill-only, CA TOU):** the unit comparison table is empty, because the workbench ranks those by dollars per dollar of cost. Bill-only sizing still runs and falls back to the largest catalog unit.
- **Deal economics:** not reachable. The model's Deal Economics code is still in the file but the workbench does not tab to it.
- **The unit editor has no price column**, so prices cannot be re-entered from the screen. A saved site file whose unit list carries prices (`sizing.units[].cost`) loads them in that browser only.
- **Self-tests** (`?selftest` or `runSelfTests()` in the console): the workbench's own suite reports 6 failures in the file as supplied (savings figures that drifted from the fixture). The Atlas copy shows 4 more, all of which rank units by price (three bill-only comparison tests and one candidate-comparison test). With the original prices put back in memory the Atlas copy reproduces the original's results exactly (349 passed, the same 6 failed).

## Updating the Workbench

The original file is not kept in the repository. When there is a new version of the workbench:

```
node scripts/scrub-workbench.mjs path/to/new-workbench.html
npm test
```

The script rewrites `assets/workbench/workbench.html`. Every edit asserts that it matched, and the script refuses to write a file that still contains an embedded font, a numeric unit cost, a non-zero price default, or any figure the source used as a price. If the workbench's code changed so that a pattern no longer matches, the script stops with the name of the edit; the pattern list lives at the top of `scrub()` in the script. `tests/workbench-asset.test.mjs` runs in CI and fails if a committed copy contains fonts or prices.

Do not edit `assets/workbench/workbench.html` by hand; changes are overwritten the next time the script runs.

## The first two tabs, built into the Site screener

The Workbench tab above is the original file in a frame. Its first two tabs are also built into the Site screener, so a site can go from a meter file to incentives and tariffs in one place:

| Workbench tab | In the screener | How it was ported |
|---|---|---|
| 1. Interval Data | **Load data** result tab: import, detection summary and overrides, KPIs, monthly peak vs average, worst-day profile, year overview, monthly table, heat map | `assets/js/interval-parse.js` is the workbench's parsing code ported verbatim (CSV and Excel readers, unit and column detection, multi-meter, DST and gap handling, the monthly analysis). On 14 test inputs (CSV layouts, DST, multi-year, multi-meter and an Excel workbook) in four time zones it matches the original field for field. Charts are redrawn as SVG instead of Chart.js. |
| 2. Sizing | **Demand savings** result tab: system picker, custom system, reserve, schedule, carry, maximize on lighter days, daily dispatch by month with audit and CSV, per-month targets, and monthly savings from the customer's bills | `assets/js/engine/hold.js` is the workbench's dispatch core (`dispatchProfileFrom`, `robustHold`, `monthSustainCheck`, schedules, reserve). It reproduces the original's sustainable holds, month checks and dispatch traces on 140 combinations of site, system and option. `assets/js/engine/demand-savings.js` ports its bill model (`dispatchSavings`: billed before/after, ratchet floor, the peak actually held below the hold) and matches the original's monthly savings on 80 combinations of site, system, ratchet, target, carry, reserve and schedule. The cost-free suggested system is its "knee" rule. |
| 3. Energy Displacement | Not built in. Use the **Workbench** tab. | |

What differs from the workbench:

- **Product list.** The screener uses the products in `data/products.json` (the four Sunbelt units and any mix of them), not the workbench's catalog, so there is no RPSLinkIN, RPS1200 or US-BESS 2.5 MW option, no unit-spec editor and no "use this system on both tabs".
- **Resolution.** Interval data is averaged to 15-minute intervals before the monthly dispatch search, as the rest of the Atlas does. 15-minute files match the workbench exactly; finer data can differ slightly.
- **Dollars.** Priced with the customer's bills, the dollars are the workbench's bill model and every option moves them. Priced with the tariff, they are the Atlas demand-charge valuation (capture factor and DR event days included), and of the workbench options only the reserve changes them. Months without a bill amount use the average $/kW of the months entered (the workbench leaves them out), or a single $/kW rate when one is given.
- **Suggested system.** The workbench's knee (smallest system within 3 points of the deepest average monthly peak cut), but only among systems no larger than the site can discharge into, so a small site is not handed a battery that "cuts" the peak by running the building.
- **No ComStock proxy.** The screener's building-type load shape covers the no-interval-file case.
- **Excel value type.** As in the workbench, choosing a value type in the override only takes effect together with a chosen value column.

## Access

The page itself is a static file under `assets/`, so it is reachable by URL without signing in, like every other file on the site. It contains no customer data and, after the scrub, no prices or fonts. Site files you open in it stay in your browser.
