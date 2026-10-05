# Maintaining the data

All research lives in JSON under `data/`. Edit it directly on GitHub (pencil icon) or locally. Pushing to `main` re-runs validation and redeploys the site.

## Ground rules (accuracy first)
1. **Never guess.** If you can't confirm a number, set it to `null` and explain in `verification_notes`. The screener excludes null rates and prompts users to enter them from the bill.
2. **Every change gets a source and a date.** Update `sources` (title + URL), `confidence` (`high` = current primary source, `medium` = primary but possibly superseded or a reputable summary, `low` = secondary or inferred), and `last_verified` (programs) or `effective_date` (tariffs).
3. Bump `data_version` and `updated` in `data/manifest.json`.
4. Run `npm run validate`. It fails on schema and reference errors and warns on missing sources, null rates, and entries older than 180 days.

## Files
- `data/manifest.json`: list of markets and their files.
- `data/jurisdictions/<market>.json`: `utilities`, `tariffs`, `programs`, `site_constraints`, `market_prices`, `panel_notes`, `open_questions`, `summary`, `default_energy_price_usd_per_kwh`.
- `data/global.json`: federal `programs` (ITC etc.), model-code `site_constraints` (IFC/NFPA 855/NEC), `market_prices` (performance/cost benchmarks), `assumptions` (modeling defaults shown in Settings).
- `data/products.json`: your SKUs. Set `installed_cost_usd_per_kwh` (or `installed_cost_usd` per unit) and `footprint_sqft` (including required clearances). Remove `cost_is_placeholder` once real.
- `data/panel.json`: personas. Utility personas are matched to sites by `utility_ids`.

## Tariff demand charges
```json
{ "label": "Summer on-peak demand", "component": "generation", "rate_usd_per_kw_month": 21.22,
  "basis": "tou_window", "months": [6,7,8,9,10], "window": {"start": 16, "end": 21}, "days": "all" }
```
- `basis`: `ncp_monthly` (monthly max, all hours), `tou_window` (needs `window`), `daily` (rate is **$/kW-day**, needs `window`), `ratchet` (monthly charge on ratcheted billing demand; also set the tariff-level `ratchet`), `coincident` (excluded from demand savings; model it as a `coincident_peak_charges` entry instead), `contract` (excluded).
- `window` can be an array for split periods: `[{"start":14,"end":16},{"start":21,"end":23}]`. Hours are 0–24, end exclusive; wrap-around like `{"start":14,"end":9}` is allowed.
- Peak tags: `coincident_peak_charges: [{ "type": "icap|plc|nspl|4cp|transmission_tag|capacity_tag", "est_value_usd_per_kw_year": 42.96, "derivation": "...", "passthrough": "supply|delivery", "min_site_peak_kw": 700, "optional_election": false }]`.
- TOU arbitrage: `arbitrage: [{ "label", "months", "peak_window", "peak_price", "offpeak_price", "days" }]` (all-in $/kWh).
- Tariff-level `min_billing_demand_kw` (or per charge): the billing floor. Shaving below it does not lower the bill, so the engine caps the billable reduction at (month peak − floor). Hawaiian Electric Schedule P bills at least 300 kW, Schedule J at least 25 kW.
- Tariff-level `energy_adder_usd_per_kwh`: a flat per-kWh amount on every hour (for example Hawaii's fuel clause) that is **not** in `peak_price` / `offpeak_price`. It does not change the spread; it raises the cost of round-trip losses. Document the source in `energy_adder_note`.
- Tariff-level `billing_demand_rule`: free text for billing-demand rules the engine does not model (such as Hawaiian Electric's "mean of the current peak and the highest of the prior 11 months"). It is exported with the tariff parameters.

## Programs
```json
"valuation": { "method": "per_kw_season", "rate": 200, "unit": "$/kW-summer",
               "duration_basis_hr": 3, "months_per_year": null, "term_years": 5 }
```
- `method`: `per_kw_season`, `per_kw_month` (+ `months_per_year`), `per_kw_year`, `per_kwh_event` (+ `expected_event_hours_per_year`), `per_mwh`, `upfront_per_kwh`, `upfront_per_kw`, `pct_of_cost` (rate as a **fraction**, e.g. 0.30), `text_only` (shown, not valued).
- `duration_basis_hr`: event length the battery must sustain. Credited kW = min(kW, usable kWh ÷ hours, site load if non-export).
- Optional: `rate_with_solar` (rate used instead of `rate` when the site has paired solar, for example Hawaii Energy's $250/kWh vs $150/kWh), `rate_by_site_peak_kw` (tiers by site peak), `schedule` (e.g. step-down in years 6–10), `cap_pct_of_cost`, `cap_usd`, `max_kwh_incentivized`, `max_kw_incentivized`.
- `eligibility`: `min_kw`, `max_kw`, `min_kwh`, `max_kwh`, `requires_export`, `requires_paired_solar`, `requires_aggregator_or_csp`, `aggregation_allowed`, `requires_disadvantaged_community`.
- `status`: `open` and `pilot` count in the base case; `waitlist` and `pending_launch` count only in upside; `closed` and `paused` are excluded.
- `stacking.conflicts_with`: program ids that can't share the same kW (the higher value is kept), or `cp:<type>` (e.g. `cp:plc`) when the program and a peak-tag reduction pay for the same kW.
- `panel_caution`: text surfaced as a panel caution whenever the program is in the recommended stack.

## Site constraints
`rule_type` drives the checks: `unit_max_kwh`, `indoor_max_kwh`, `outdoor_group_max_kwh`, `outdoor_setback_ft`, `rooftop_rule`, `garage_rule`, `permit_threshold_kwh`, `site_max_kwh`, `site_max_kw`, `threshold_kwh`, `text` (reference only). Market-specific rules override the model-code defaults in `global.json` (e.g. FDNY's indoor limit for NYC).
