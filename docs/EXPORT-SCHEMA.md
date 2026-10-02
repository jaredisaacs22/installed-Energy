# Export schema (v1.0)

The screener exports one site and the portfolio exports many, each as an Excel workbook (`.xlsx`) or a ZIP of CSVs with the same tables. Join tables on `site_id` (+ `config_id`). Money is USD; power is kW; energy is kWh.

## Inputs
One row per input: `section` (`site` | `assumption` | `meta`), `key`, `value`. Includes `export_schema_version` and `generated_at`.

## Configs (one row per battery configuration)
| Column | Meaning |
|---|---|
| `config_id` | e.g. `2xB200-418` (count × product id) |
| `recommended` | `yes` for the highest-NPV configuration without critical site issues |
| `units`, `kw`, `kwh`, `duration_hr` | Configuration totals |
| `installed_cost_usd` | From product costs (Settings) |
| `annual_value_base_usd` / `_upside_usd` | Year-1 value. Upside adds waitlisted/pending programs, optional tariff elections, and tag savings a fixed supply contract would hold back |
| `upfront_incentives_base_usd` / `_upside_usd` | Rebates + ITC (+ NYC property-tax abatement) |
| `om_usd_per_yr` | Year-1 O&M |
| `net_cost_base_usd`, `simple_payback_base_yr`, `npv_base_usd`, `irr_base` | Base-case economics |
| `simple_payback_upside_yr`, `npv_upside_usd` | Upside economics |
| `programs_not_enrolled` | Dispatch programs left out because their event days would cost more in demand-charge savings than they pay (see the Panel sheet) |
| `constraint_status` | Worst site-check severity: `ok` / `info` / `caution` / `critical` |
| `constraint_issues` | Caution/critical checks, pipe-separated |

## ValueStreams (configuration × stream, long format)
| Column | Meaning |
|---|---|
| `stream_key` | Unique within a config (`demand:0`, `cp:1`, `arb:0`, `prog:<id>`, `losses`) |
| `category` | `demand_charge`, `coincident_peak`, `energy_arbitrage`, `demand_response`, `performance_incentive`, `wholesale_market`, `upfront_incentive`, `tax`, `cost` |
| `program_id` | For program streams |
| `scenario` | `base` or `upside` |
| `confidence` | `high` / `medium` / `low` / `user` (your override) |
| `annual_usd`, `upfront_usd` | Year-1 annual value; one-time value |
| `kw_credited` | kW used for this stream: demand reduction, or deliverable kW for the program's event duration |
| `rate`, `unit` | Rate applied |
| `term_years` | Program term if known |
| `flags` | `ratchet`, `duration_short`, `duration_assumed`, `aggregator_required`, `fixed_supply_contract`, `optional_election` |
| `basis` | Human-readable calculation |

## TariffParams (for an interval-data bill model)
| Column | Meaning |
|---|---|
| `element` | `demand_charge`, `energy_rate`, `coincident_peak`, `ratchet` |
| `label`, `component` | e.g. distribution / transmission / generation |
| `basis` | `ncp_monthly`, `tou_window`, `daily` ($/kW-day), `ratchet`, `coincident`, `contract` |
| `rate`, `unit` | `$/kW-month`, `$/kW-day`, `$/kWh`, `$/kW-yr`, or a fraction for ratchets |
| `months` | Pipe-separated month numbers (1–12) |
| `window_start_hr`, `window_end_hr` | Hour-of-day window (end exclusive; may wrap midnight). Blank = all hours |
| `days` | `weekdays` or `all` |
| `notes` | Hours text, derivation, lookback |

Rows with a blank `rate` are elements the database could not verify. Fill them from the tariff or the customer bill.

## Programs
Program id, status, eligibility for the recommended config (`yes` / `via aggregator` / `no` + reason), `method`, `rate`, `unit`, `months_per_year`, `duration_basis_hr`, event window and season, typical/max events per year, size thresholds (`min_kw`, `max_kw`, `min_kwh`, `max_kwh`), `term_years`, `conflicts_with`, `confidence`, `last_verified`, `source_url`.

## SiteLimits
`limit`, `value`, `unit`, `note`. Covers service kVA, NEC 705.12 maximum inverter kW, charging headroom, the useful discharge ceiling, minimum load, indoor kWh limit, per-unit kWh limit, max units by space, and interconnection track thresholds.

## Panel
`source` (`site review` | `market briefing`), `persona`, `severity`, `title`, `text`.

## Workbench site file (`<site>-site.json`)

**Export → Download site file for the workbench** writes the Site Analysis Workbench's own file format. Every key the workbench saved is kept unchanged, including `raw` (interval data), `meta`, `tariffs`, `sizing` and any sibling-tool keys. Atlas adds one key, `atlas` (schema `atlas.v1`). The workbench keeps unknown keys when it opens and re-saves a file, so the block survives round trips.

| Field | Contents |
|---|---|
| `schema`, `generated_at`, `data_version` | Format id, timestamp, Atlas data version |
| `site` | Market, utility, tariff id/name, peak kW, annual kWh, voltage, supply contract |
| `load_basis` | `interval data <start> to <end> (<days> days)` or `design-day load shape` |
| `rates_missing` | Tariff elements without a rate (excluded from savings) |
| `recommended` | Config id/label, kW, kWh, deliverable kWh, base/upside annual value, upfront incentives, installed cost, payback, NPV, constraint status, programs not enrolled, and `value_streams` (label, category, case, annual $, upfront $, kW credited, confidence, calculation basis) |
| `configurations` | The same summary for every configuration |
| `tariff_params` | Same rows as the TariffParams sheet |
| `site_limits` | Same rows as the SiteLimits sheet |
| `panel` | Critical and caution notes (severity, title) |

Without an imported file, the button writes a minimal workbench file (meta plus `atlas`) that the workbench can open.

