# BESS Incentive Atlas

A static website (GitHub Pages) for screening **behind-the-meter commercial, industrial and retail battery storage** sites in **Massachusetts, Connecticut, New York City (Con Edison), Illinois, Texas (ERCOT), California and Hawaii**.

For any site it:

- **Values every battery configuration** built from your products: 30 kW/150 kWh, 65 kW/200 kWh, 200 kW/418 kWh, 200 kW/600 kWh, and multiples of each. Value streams covered:
  - demand charges
  - capacity and transmission peak tags (ICAP, PLC, NSPL, ERCOT 4CP; Hawaii has none)
  - TOU energy shifting
  - demand-response and performance programs
  - upfront incentives and the federal ITC
- **Flags what limits battery size:**
  - the NEC 705.12 120% rule and service charging headroom
  - the non-export discharge ceiling
  - interconnection tracks and secondary network grids
  - IFC 1207 / NFPA 855 / FDNY fire-code limits (unit size, 600 kWh groups, indoor caps, setbacks, rooftop rules)
  - available space
- **Runs an expert-panel review.** Simulated advisory personas cover each utility territory, a retail-supply/VPP aggregator, a fire-code specialist, and a BESS & interconnection engineer who challenges the result.
- **Exports to Excel or CSV** for your interval-data model, including machine-usable tariff parameters (demand windows, months, rates).

> **Accuracy notice.** The database was researched on 2026-10-01 from web-search summaries of primary sources; direct document retrieval was blocked in the research environment. Every value carries a confidence level, sources and a verified date. Unverified rates are stored as `null` and excluded rather than guessed. You can enter rates from a customer's bill in the screener. Treat outputs as screening estimates, not investment-grade numbers.

## Using the site

1. **Sign in** with an `@sunbeltrentals.com` email address (see [docs/ACCESS.md](docs/ACCESS.md), and note the limits of a static-site gate).
2. **Overview:** compare markets side by side: total demand charges, peak-tag values, open programs, rate coverage and watch-outs. The product-fit table shows how much of each battery's kW a program credits for its event duration.
3. **Site screener:** pick the market, utility and rate and enter peak kW and annual kWh (or open a meter file). Electrical service, siting and commercial details are optional and folded away; they feed the size limits and program eligibility. Results update as you type.
   - **The summary** at the top answers the evaluation question without costs: the site's peak, the suggested battery, how far it cuts each month's peak (kW and %), and the demand savings per year. Costs are ignored until you enter real installed costs in Settings; then payback appears too.
   - **Demand savings** (the first tab) is the model. Pick the battery system (★ = suggested: the smallest system within 3 points of the deepest average monthly peak cut any option reaches, among systems the site can discharge into). Under **Demand charges**, price demand with the **tariff rates** on file or with the **customer's bills**: one $/kW rate for every month, or each month's demand charges ($) and billed demand (kW) typed or pasted from a spreadsheet, plus an optional billing floor (ratchet). **Savings by month** then shows, for every month, the peak the battery holds, the billed demand after the battery, the $/kW and the savings. With the bills, savings use the Site Analysis Workbench's bill model: (billed demand − billed demand with the battery) × $/kW, never below the ratchet floor. Each month's target can be edited; below the sustainable hold the month is billed at the peak actually held. **How the battery runs** (daily dispatch by month, state of charge, an interval-by-interval audit with CSV downloads) and **Dispatch settings** (custom system mix, reserve capacity, dispatch schedule, carry charge across days, deeper discharge on lighter days, the workbench's options) are folded below.
   - **Have a meter interval file or a workbench file?** Click **Open file** at the top of the form (or drop it on the **Load data** tab): a CSV, TSV or Excel meter export, or the `<site>-site.json` the workbench saved. The Interval data tab is the workbench's Interval Data tab built in: it reads the date, kW or kWh and interval length (with the unit column, preamble, split date/time, multiple meters and gaps handled as the workbench does), shows how it was read with overrides, and charts the load (monthly peak vs average, worst-day profile, year overview with drag-to-zoom, monthly table, month x hour heat map). Atlas fills in the market, utility, voltage, peak, annual kWh and minimum load, then sizes every month from the real interval data, checking each month's demand caps against every day of that month. A **Workbench cross-check** card (Compare systems) compares the workbench's selected system and the bills with the selected rate. **Export → Download site file for the workbench** returns the file with Atlas results added under `atlas`; it opens in the workbench as before. Interval data stays in your browser (IndexedDB).
   - Without a meter file, paste a peak-day profile (24 or 96 values) from your interval model to replace the generic load shape. With the customer's bills, each month's billed kW also scales the design day for that month.
   - **Compare systems** lists every configuration with its peak cut, demand savings and other value (demand response, peak tags, energy shifting). **Site checks** has the electrical, fire-code and interconnection checks for the selected system, the site limits, and the expert panel (folded). **Rates & programs** has the tariff (enter rates from a bill where the database has none), every value stream of the selected system, and the programs. **Export** downloads Excel/CSV (with a DemandByMonth sheet), the workbench site file, a share link and a print-ready report. **Save to portfolio** is at the top of the page.
   - The **accuracy checklist** (folded under the summary) lists what is still estimated. A site is *planning-grade* only when rates, supply contract, electrical data and interval data are all in.
4. **Portfolio:** save sites or import a CSV ([template](templates/site_import_template.csv); the optional `demand_rate_usd_per_kw` and `ratchet_pct` columns price demand from the bills) to rank install locations by demand savings, savings per kWh of battery, peak cut or site score, and export the whole portfolio.
5. **More → Workbench:** the Site Analysis Workbench (peak-demand shaving model) runs inside the site, unchanged except that embedded fonts and unit prices were removed because the repository is public. Save a site there, then open it in the Site screener. See [docs/WORKBENCH.md](docs/WORKBENCH.md).
6. **More → Data health:** see which rates are verified, which are missing, which values are low-confidence, and the verification log of every change and its evidence.
7. **Settings:** enter your **actual installed cost** per product to add payback and NPV (the shipped $600/kWh is a placeholder, so costs are ignored until you do), and product footprints to enable the space check. These are saved in your browser.

## Deploying to GitHub Pages

1. In the repository on GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main`. The workflow in `.github/workflows/pages.yml` runs the tests and data validation, then publishes the site.

Run it locally:

```bash
npm test                 # engine unit tests (node:test, no dependencies)
npm run validate         # data validation + engine smoke test across every tariff
python3 -m http.server 8080   # then open http://localhost:8080
```

## Repository layout

| Path | What it is |
|---|---|
| `index.html`, `assets/css`, `assets/js` | The app (vanilla ES modules, no build step) |
| `assets/js/engine/` | Pure calculation engine: load shapes & peak shaving, value stack, site limits, finance, scoring, panel rules |
| `assets/js/views/` | Screener, portfolio, library, panel, methodology, settings pages |
| `assets/js/export.js` | Dependency-free CSV / ZIP / XLSX writers and export tables |
| `assets/js/access.js` | Email-domain sign-in gate (`ALLOWED_DOMAINS`) |
| `assets/workbench/workbench.html`, `assets/js/views/workbench.js`, `scripts/scrub-workbench.mjs` | The hosted Site Analysis Workbench (fonts and prices removed), its iframe view, and the script that generates it from the original file. See [docs/WORKBENCH.md](docs/WORKBENCH.md) |
| `assets/js/workbench.js`, `assets/js/interval-store.js` | Site Analysis Workbench file interchange (decode interval data, map fields, merge results back) and browser storage for imported files |
| `data/jurisdictions/*.json` | Per-market utilities, tariffs, programs, site constraints, market prices, panel notes |
| `data/global.json` | Federal tax items, model fire/electrical codes, modeling assumptions |
| `data/products.json` | Your battery products (kW, kWh, cost, footprint) |
| `data/panel.json` | Expert-panel persona roster |
| `scripts/validate-data.mjs` | Validator run in CI |
| `docs/` | Methodology, data maintenance, export schema, access control, workbench |

See [docs/DATA-MAINTENANCE.md](docs/DATA-MAINTENANCE.md) to update programs and tariffs, and [docs/EXPORT-SCHEMA.md](docs/EXPORT-SCHEMA.md) for the export columns.
