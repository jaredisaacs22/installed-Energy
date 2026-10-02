// Methodology, data freshness and maintenance guide.
import { h, num, confBadge } from '../ui.js';

export function renderMethod(root, data) {
  const A = Object.fromEntries((data.global.assumptions || []).map((a) => [a.key, a]));
  const val = (k) => (A[k] ? String(A[k].value) : '?');
  const juris = data.manifest.jurisdictions.map((m) => data.jurisdictions[m.code]);
  const conf = (items) => {
    const c = { high: 0, medium: 0, low: 0 };
    items.forEach((x) => (c[x.confidence] = (c[x.confidence] || 0) + 1));
    return c;
  };
  const nullRates = (j) => (j.tariffs || []).reduce((n, t) => n + (t.demand_charges || []).filter((d) => d.rate_usd_per_kw_month == null).length, 0);

  root.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Methodology & data'), h('p', {}, 'How the screener values a battery, what it assumes, how fresh the data is, and how to keep it current.'))),
    h('div', { class: 'card' },
      h('h2', {}, 'Data freshness by market'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Market', 'Researched', 'Tariffs', 'Unverified demand rates', 'Programs', 'Program confidence (H/M/L)', 'Site constraints', 'Open questions'].map((t) => h('th', {}, t)))),
        h('tbody', {}, juris.map((j) => {
          const c = conf(j.programs || []);
          return h('tr', {},
            h('td', {}, h('strong', {}, j.name)),
            h('td', {}, j.researched_on || '—'),
            h('td', { class: 'num' }, num((j.tariffs || []).length)),
            h('td', { class: 'num' }, num(nullRates(j))),
            h('td', { class: 'num' }, num((j.programs || []).length)),
            h('td', { class: 'num' }, `${c.high}/${c.medium}/${c.low}`),
            h('td', { class: 'num' }, num((j.site_constraints || []).length)),
            h('td', { class: 'num' }, num((j.open_questions || []).length)),
          );
        })),
      )),
      h('p', { class: 'small muted', style: { marginTop: '8px' } }, data.manifest.research_note || ''),
    ),
    h('div', { class: 'card prose' },
      h('h2', {}, 'How a site is valued'),
      h('p', {}, 'For each candidate configuration (1…N units of each product, stopping once battery kW exceeds what the site can absorb without exporting), the engine computes these value streams:'),
      h('ol', {},
        h('li', {}, h('strong', {}, 'Demand charges. '), `With a workbench site file, every month is sized from its real interval data: a greedy optimizer first finds reductions on the month’s envelope (the highest load at each time of day, a worst case), then deepens them as far as the caps still hold on every actual day of that month (power, energy, and recharge without a new peak). This matches the Site Analysis Workbench within its 0.5 kW rounding. Without interval data, a representative peak weekday is built from the building type and calibrated to the load factor, or taken from a profile you paste. Either way the optimizer lowers each demand-charge window (all-hours, on-peak, mid-peak), best $ per kWh first, and stops when the battery runs out of kW, energy or recharge room. The reduction is multiplied by a capture factor of ${val('shave_capture')} for forecasting misses. Your own model’s number can replace it per configuration.`),
        h('li', {}, h('strong', {}, 'Battery specs. '), 'Each product uses its own usable energy, charge kW and efficiency (Viridi: 94% charge × 94% discharge). Usable kWh is stored energy; what reaches the meter is usable × discharge efficiency (130.2 kWh × 0.94 = 122.4 kWh for the 30/150), the same convention as the workbench. The 65/200 charges at 40 kW, which limits overnight recharge. Products without specs fall back to the global usable-energy and efficiency assumptions.'),
        h('li', {}, h('strong', {}, 'Peak tags. '), `Capacity (ICAP/PLC), transmission (NSPL, RNS) and ERCOT 4CP: kW the battery can hold for ${val('cp_dispatch_hours')} h (never more than site load) × hit rate ${val('cp_hit_rate')} × $/kW-yr. These count in the base case only when they reach the customer: a pass-through/index supply contract, a utility delivery charge, or default service that bills on the tag (e.g. ComEd hourly). Unknown, fixed all-in or fixed default supply moves them to upside.`),
        h('li', {}, h('strong', {}, 'Energy shifting. '), `Discharge in the TOU peak window and recharge off-peak, net of the product’s round-trip efficiency (fallback ${val('rte_ac')}); with interval data, on the season’s typical weekday. Energy already used to shave demand outside the window is unavailable, and recharging must fit under the shaved demand caps. On flat-energy tariffs the cost of cycling losses is subtracted instead.`),
        h('li', {}, h('strong', {}, 'Programs. '), `Deliverable kW = min(nameplate kW, usable kWh ÷ the program's event duration, site load × ${val('event_load_fraction')} unless the program pays for export). That is multiplied by performance ${val('dr_performance')}, any capacity accreditation (e.g. PJM DR ELCC), the customer share after an aggregator (${val('aggregator_customer_share')}), and the program rate. Program kW minimums are compared with deliverable kW. Mutually exclusive programs keep only the higher-value one. Waitlisted, pending or unconfirmed-eligibility programs count only in the upside case. After a program's rate-lock term, value is multiplied by ${val('post_term_value_factor')}.`),
        h('li', {}, h('strong', {}, 'DR events vs. demand shaving. '), 'For programs with scheduled event windows (ConnectedSolutions Daily, CT ESS, Con Ed CSRP), event days are assumed to fall on the month’s peak day, because utilities call events on hot, high-load days. On an event day the battery delivers the event first, then shaves with the energy and kW it has left (no charging during the event, and recharging must not set a new peak). The month’s demand saving is the lesser of a normal day and an event day. Con Ed assigns each network one of four CSRP call windows; pick the site’s window in Rates & programs.'),
        h('li', {}, h('strong', {}, 'Dispatch strategy. '), 'When event days cut into demand-charge savings, the engine also values the stack without each such program, and without all of them, and keeps whichever earns more in year 1 (base case). A program left out this way is listed as “Not enrolled” with the dollar trade-off, and the BESS & interconnection reviewer flags it.'),
        h('li', {}, h('strong', {}, 'Confidence. '), 'Each value stream carries the confidence of its source. When a program’s dollar value depends on an estimate (for example, expected ELRP event-hours), the stream takes the weaker of the two.'),
        h('li', {}, h('strong', {}, 'Ratchets. '), 'Where a demand charge is billed on ratcheted demand (e.g. Oncor 80%), a kW shaved off the summer peak is worth the ratchet percentage in the eight non-summer months.'),
        h('li', {}, h('strong', {}, 'Upfront. '), 'Per-kWh/per-kW rebates (with caps), then the federal ITC on cost net of rebates (when “incentives reduce ITC basis” is on). The ITC counts in base only after you confirm FEOC/MACR compliance in Settings. At ≥ 1 MW AC without prevailing wage & apprenticeship it drops to 6%. The NYC property-tax abatement counts only for building owners and is paid over 4 years.'),
        h('li', {}, h('strong', {}, 'Missing rates. '), 'A tariff element with no verified rate is excluded, never treated as zero. The site’s score is marked incomplete (*), and incomplete sites rank after complete ones in the portfolio until you enter the rate from the bill.'),
      ),
      h('p', {}, `Economics: simple payback = (installed cost − upfront) ÷ (year-1 value − O&M). NPV over ${val('analysis_years')} years at ${val('discount_rate_pct')}% with ${val('degradation_pct_yr')}%/yr degradation and ${val('escalation_pct_yr')}%/yr tariff escalation. The recommended configuration is the one with the highest NPV among those without critical site issues.`),
      h('h2', {}, 'Site limits'),
      h('ul', {},
        h('li', {}, 'NEC 705.12 120% rule: 1.25 × inverter current + main breaker ≤ 1.2 × busbar. Above that you need a supply-side tap, a main breaker derate, a Power Control System (705.13) or new gear.'),
        h('li', {}, 'Service charging headroom: 80% of service kVA minus the load at charging time.'),
        h('li', {}, 'Non-export ceiling: discharge can’t usefully exceed site load during events.'),
        h('li', {}, 'Fire code (IFC §1207 / NFPA 855): 50 kWh per unit unless large-scale fire-test data (UL 9540A) is accepted; 600 kWh per fire area / outdoor group; 10 ft outdoor separation (reducible); local overrides such as FDNY in NYC.'),
        h('li', {}, 'Interconnection track by inverter kW; secondary networks (non-export protection, and inverter kW above minimum load flagged); tariff options with minimum storage size (PG&E Option S ≥ 10% of peak); space (needs product footprint in Settings); flood zone.'),
        h('li', {}, 'kVA-billed demand charges (e.g. CenterPoint, some Eversource rates) are treated as kW, which can overstate savings by a few percent at non-unity power factor.'),
      ),
      h('h2', {}, 'Site score'),
      h('p', {}, 'Economics 50% (payback ≤ 4 yr → 100, ≥ 12 yr → 0; capped at 40 when NPV is negative), certainty 20% (share of value from base-case streams that are not low-confidence), feasibility 30% (100 minus 45 per critical issue, 12 per caution, 2 per info). Grades: A ≥ 80, B ≥ 65, C ≥ 50, D ≥ 35.'),
      h('h2', {}, 'Expert panel'),
      h('p', {}, 'Personas are simulated advisory perspectives: utility program managers for each territory, a retail-supply/VPP aggregator, a fire-code/permitting specialist, and a BESS & interconnection engineer who challenges the result. Their notes come from researched market briefings plus rules evaluated against each site. They are not statements by, or affiliated with, any named company.'),
      h('h2', {}, 'Accuracy rules for the data'),
      h('ul', {},
        h('li', {}, 'Every tariff, program and constraint carries sources, a confidence level (high / medium / low) and an effective or verified date.'),
        h('li', {}, 'Unknown numbers are stored as null, never guessed. A null demand rate is excluded from the value until you enter it from the customer bill (Rate panel in the screener).'),
        h('li', {}, 'Your overrides (bill rates, program rates, shave kW, product costs) are shown with a “user” confidence badge and flow through to exports.'),
      ),
      h('h2', {}, 'Updating the data'),
      h('ol', {},
        h('li', {}, 'Edit data/jurisdictions/<market>.json (programs, tariffs, constraints) or data/global.json (federal items, model codes, assumptions) directly on GitHub.'),
        h('li', {}, 'Update “last_verified”, “sources” and “confidence” on whatever you change. Bump data_version and updated in data/manifest.json.'),
        h('li', {}, 'Run “npm run validate” (also runs in CI) to catch schema errors, missing sources and stale entries.'),
        h('li', {}, 'Commit to main. GitHub Pages redeploys automatically.'),
      ),
      h('h2', {}, 'Export schema'),
      h('p', {}, 'The Excel workbook and CSV bundle contain: Inputs (site inputs + assumptions), Configs (one row per configuration), ValueStreams (long format: configuration × stream with rate, unit, kW credited and calculation basis), TariffParams (demand charges with months and hour windows, energy rates, peak-tag $/kW-yr and ratchet, ready for an interval-data bill model), Programs (rates, event durations, size thresholds, conflicts), SiteLimits and Panel. Join on site_id + config_id. See docs/EXPORT-SCHEMA.md for column definitions.'),
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'Current assumptions'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Key', 'Value', 'Description', 'Source'].map((t) => h('th', {}, t)))),
        h('tbody', {}, (data.global.assumptions || []).map((a) => h('tr', {}, h('td', {}, a.label || a.key), h('td', { class: 'num' }, String(a.value)), h('td', { class: 'small ink2' }, a.description || ''), h('td', { class: 'small muted' }, a.source || '')))),
      )),
    ),
  );
}
