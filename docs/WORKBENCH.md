# Site Analysis Workbench (the Workbench tab)

The **Workbench** tab hosts the Site Analysis Workbench, the single-file peak-demand shaving model, inside the Atlas. It loads `assets/workbench/workbench.html` in a same-origin iframe, so it behaves exactly like the standalone file: its own Interval Data / Sizing / Energy Displacement tabs, its own **Open / Save / Print**, and its own browser autosave (`sie_nofin`). **Open full screen** opens the same page in its own tab.

With the team passphrase, **Unlock prices** in its top bar turns on unit prices and the financial tabs (Tariffs & Bills, Revenue, Deal Economics, Summary): see [Prices](#prices-the-encrypted-price-book) below.

The Atlas does not change the model's math. The workbench still exchanges `<site>-site.json` files with the Site screener (see [EXPORT-SCHEMA.md](EXPORT-SCHEMA.md)): save the site in the Workbench, then **Site screener → Open site file**.

## Prices: the encrypted price book

Unit prices are never published in readable form. They live in a price book that is committed only encrypted (`assets/workbench/pricebook.enc.json`, AES-GCM-256 with a key derived from the team passphrase by PBKDF2-SHA256, 600,000 iterations) and is embedded in the workbench page, so the page still works offline as a single file. The passphrase is shared with the team directly. It is never committed, and it never goes in an issue, pull request or chat channel.

**Using it.** Click **Unlock prices** in the workbench's top bar and enter the passphrase. Tick **Remember on this device** to skip the passphrase next time (don't tick it on a shared computer). Unlocking:

- fills the unit catalog's prices, and the install-cost and O&M starting figures in Deal Economics. A price that a site file already carries is kept.
- sets the monthly service fee from the book's per-unit rental rates, until a fee is typed for the deal.
- brings back the billing-mode switcher (**$/kW Demand charge**, **$/kWh TOU**, **Peak shave only**) and the **Tariffs & Bills**, **Revenue**, **Deal Economics** and **Summary** tabs that the workbench file has always carried. In a billing mode, the Sizing tab ranks units by cost again, as the original does.
- **Deal Economics** shows both deal types, exactly as in the original workbench:
  - **Rental:** a customer proposal snapshot with the monthly service fee, bill savings, net benefit to the customer, the share of savings they keep, and Sunbelt's rental revenue.
  - **Purchase / ownership:** a pro forma with the cost stack, ITC, depreciation, battery residual value, O&M, degradation, payback, NPV and IRR.

A site in **Peak shave only** mode has no dollar savings. The money tabs say so, with a link to Tariffs & Bills, where you choose a billing mode and enter the monthly bills.

**Lock** (from the **Prices on** button) forgets the key on this device, takes the price book's figures back out of the open site, and returns to the kW-only workbench. A billing mode chosen while unlocked is parked and comes back on the next unlock. Typed deal figures (a battery cost or fee entered for the deal) are left alone.

One fix rides along: the original priced the battery from the single sized unit only, so a hand-built mix of models was priced as catalog unit #1. Unlocked, a mix is priced as the sum of its units.

With the price book unlocked, the Atlas copy reproduces the original workbench's self-test results exactly (349 passed, the same 6 failed).

**Who can see prices.** Anyone with the passphrase. The encrypted file is public and can be attacked offline, so the passphrase must be long and random, never a word or phrase. A remembered key is stored in that browser's local storage for the Atlas site. To revoke access, re-encrypt with a new passphrase (below): every remembered key stops working and everyone re-enters the new one.

### Changing prices

From the workbench (no tools needed):

1. Click **Prices on** and edit the price, trailer-mounted price and monthly rental for each unit, and the install, O&M and new-unit-type figures. **Apply** uses them in this browser until the page is reloaded.
2. **Download encrypted price book** saves `pricebook.enc.json`, encrypted with the same passphrase.
3. Replace `assets/workbench/pricebook.enc.json` in the repository with it, then run `node scripts/workbench-addon.mjs` and `npm test`, and commit both files.

From the command line (also how to change the passphrase). Keep the plain file outside the repository; `.gitignore` refuses `*pricebook*.json` other than the encrypted one.

```
read -s PRICEBOOK_PASSPHRASE && export PRICEBOOK_PASSPHRASE   # typed, not in shell history
node scripts/pricebook.mjs decrypt > ~/pricebook.json         # edit ~/pricebook.json
node scripts/pricebook.mjs encrypt ~/pricebook.json           # writes assets/workbench/pricebook.enc.json
node scripts/workbench-addon.mjs                              # embeds it in workbench.html
npm test
```

To change the passphrase, decrypt with the old one, then `export PRICEBOOK_PASSPHRASE` to the new one before `encrypt`. `node scripts/pricebook.mjs extract <workbench.html>` builds a price book from a workbench source file that still has its prices.

The plain price book looks like this (amounts in US dollars; `null` means no price):

```json
{
  "version": 1,
  "updated": "2026-10-12",
  "currency": "USD",
  "units": { "65/200": { "price": 0, "trailer_price": 0, "rental_per_month": null } },
  "new_unit_price": 0,
  "defaults": { "install_usd": 0, "om_usd_per_yr": 0 }
}
```

`units` is keyed by the workbench catalog id. A unit missing from the book, or with a `null` price, stays unpriced, which is how the 2.5 MW unit has always shipped.

## What was removed, and why

The repository and the GitHub Pages site are publicly readable, and the sign-in gate is client-side only ([ACCESS.md](ACCESS.md)). Anything committed under `assets/` can be fetched by URL, so two things in the original file are **not** published:

| Removed | Replaced with |
|---|---|
| The four embedded DIN Pro font files (`@font-face` data URIs) | Nothing. The CSS font stacks are unchanged (`"DIN Pro", "Segoe UI", Arial, …`), so DIN Pro is used on machines where it is installed and a system font everywhere else. |
| Unit prices: every `cost` in the `UNITS` catalog and the trailer option price | `cost:null` in the code. The catalog already supports price-less units (the 2.5 MW unit shipped that way). The prices come back from the encrypted price book when it is unlocked. |
| Default battery, install, capex and O&M amounts in `blankEconomics()` | `0` |
| The default price of a newly added unit type | `null` |
| Help text that quoted an install-cost default and an O&M price range | Neutral wording |
| Code comments naming a specific customer opportunity and a vendor pro forma | Generic wording |
| Self-test fixtures that were built on the real battery price | Round fixture amounts, with the expected values recomputed |

Added: a provenance comment at the top, one console hint at the start of `runSelfTests()`, the Atlas add-on (the price book and its unlock, between `ATLAS-ADDON` marker comments) and three one-line hooks it needs: the billing-mode switcher and the kW-only rule on restore and on Open now follow the lock. Everything else is byte-for-byte the source file.

## What behaves differently while prices are locked

- **Interval data, peak-shave mode (the default workflow):** the recommended system, the per-month sustainable holds and every candidate's savings matched the original on the four synthetic sites compared. Candidates that are not recommended are ordered by savings instead of by cost, because there is no cost to break ties.
- **Billing modes without interval data (bill-only, CA TOU):** the unit comparison table is empty, because the workbench ranks those by dollars per dollar of cost. Bill-only sizing still runs and falls back to the largest catalog unit.
- **Deal economics:** hidden, with the Tariffs & Bills, Revenue and Summary tabs and the billing-mode switcher, until the price book is unlocked.
- **The unit editor has no price column** (nor does the original's); prices come from the price book, or per deal in Deal Economics. A saved site file whose unit list carries prices (`sizing.units[].cost`) loads them in that browser only.
- **Self-tests** (`?selftest` or `runSelfTests()` in the console): the workbench's own suite reports 6 failures in the file as supplied (savings figures that drifted from the fixture). Locked, the Atlas copy shows 4 more, all of which rank units by price (three bill-only comparison tests and one candidate-comparison test). Unlocked, it reproduces the original's results exactly (349 passed, the same 6 failed).

## Updating the Workbench

The original file is not kept in the repository. When there is a new version of the workbench:

```
node scripts/scrub-workbench.mjs path/to/new-workbench.html
npm test
```

The script rewrites `assets/workbench/workbench.html`. Every edit asserts that it matched, and the script refuses to write a file that still contains an embedded font, a numeric unit cost, a non-zero price default, or any figure the source used as a price. If the workbench's code changed so that a pattern no longer matches, the script stops with the name of the edit; the pattern list lives at the top of `scrub()` in the script. Its last step adds the Atlas add-on and the encrypted price book. If the new version's prices changed, update the price book too (above).

The add-on lives in `scripts/workbench-addon/` (`crypto.js`, `addon.js`, `addon.css`). After changing it, or the price book, `node scripts/workbench-addon.mjs` puts the new copy into the committed page without the workbench source file.

`tests/workbench-asset.test.mjs` and `tests/pricebook.test.mjs` run in CI. They fail if a committed copy contains fonts or readable prices, if the page's add-on or price book is out of date with `scripts/workbench-addon/` and `pricebook.enc.json`, or if the browser and command-line encryption stop agreeing.

Do not edit `assets/workbench/workbench.html` by hand; changes are overwritten the next time either script runs.

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

The page itself is a static file under `assets/`, so it is reachable by URL without signing in, like every other file on the site. It contains no customer data, no fonts and no readable prices: prices are only in the encrypted price book, which needs the team passphrase. Site files you open in it stay in your browser.
