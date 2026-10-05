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
3. **Site screener:** pick the market, utility and rate, enter peak kW and annual kWh, and add electrical service and siting details. Results update as you type.
   - **Have a Site Analysis Workbench file?** Click **Open site file** at the top of the form and pick the `<site>-site.json` the workbench saved. Atlas fills in the market, utility, voltage, peak, annual kWh and minimum load. It then sizes every month from the real interval data, checking each month's demand caps against every day of that month. A **Workbench cross-check** card compares the workbench's selected system and the bills with the selected rate. **Export → Download site file for the workbench** returns the same file with Atlas results added under `atlas`; it opens in the workbench as before. Interval data stays in your browser (IndexedDB).
   - Paste a peak-day profile (24 or 96 values) from your interval model, or enter "Shave kW (your model)" per configuration, to replace the generic load-shape estimate.
   - Open the **Rate** panel to enter demand charges from the customer's bill where the database has no verified rate.
   - Work through the **accuracy checklist** at the top of the results. A site is *planning-grade* only when rates, costs, supply contract, electrical data and interval data are all in. Results are split into tabs: Sizing, Savings, Site limits, Expert panel, Rates & programs, and Export.
   - **Savings** is laid out like the workbench's Sizing tab. It has a daily dispatch chart for each month's worst day (original load, shaved load, target), state of charge, a dispatch check (target held, peak after shave, max discharge, energy used, lowest charge, days held), and a **per-month peak targets & savings** table (Month, Peak, Sustainable hold, Target, kW reduction, Demand $). Toggle between the **workbench view** (sustainable hold, comparable one-to-one with the workbench) and the **planned target** the dollars assume (after the capture factor and any DR event days). Monthly demand-savings bars and the full annual value stack follow. **Print site report** produces a clean PDF-ready summary.
4. **Data health:** see which rates are verified, which are missing, which values are low-confidence, and the verification log of every change and its evidence.
5. **Portfolio:** save sites or import a CSV ([template](templates/site_import_template.csv)) to rank many sites at once and export the whole portfolio.
6. **Settings:** enter your **actual installed cost** per product (the shipped $600/kWh is a placeholder) and product footprints (to enable the space check). These are saved in your browser.

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
| `assets/js/workbench.js`, `assets/js/interval-store.js` | Site Analysis Workbench file interchange (decode interval data, map fields, merge results back) and browser storage for imported files |
| `data/jurisdictions/*.json` | Per-market utilities, tariffs, programs, site constraints, market prices, panel notes |
| `data/global.json` | Federal tax items, model fire/electrical codes, modeling assumptions |
| `data/products.json` | Your battery products (kW, kWh, cost, footprint) |
| `data/panel.json` | Expert-panel persona roster |
| `scripts/validate-data.mjs` | Validator run in CI |
| `docs/` | Methodology, data maintenance, export schema, access control |

See [docs/DATA-MAINTENANCE.md](docs/DATA-MAINTENANCE.md) to update programs and tariffs, and [docs/EXPORT-SCHEMA.md](docs/EXPORT-SCHEMA.md) for the export columns.
