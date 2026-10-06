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

## Access

The page itself is a static file under `assets/`, so it is reachable by URL without signing in, like every other file on the site. It contains no customer data and, after the scrub, no prices or fonts. Site files you open in it stay in your browser.
