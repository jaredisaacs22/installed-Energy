// Synthetic test data — NOT real tariffs. Numbers chosen for easy hand-checking.
export const products = [
  { id: 'B30-150', label: '30 kW / 150 kWh', kw: 30, kwh: 150, installed_cost_usd_per_kwh: 600 },
  { id: 'B65-200', label: '65 kW / 200 kWh', kw: 65, kwh: 200, installed_cost_usd_per_kwh: 550 },
  { id: 'B200-418', label: '200 kW / 418 kWh', kw: 200, kwh: 418, installed_cost_usd_per_kwh: 450 },
  { id: 'B200-600', label: '200 kW / 600 kWh', kw: 200, kwh: 600, installed_cost_usd_per_kwh: 420 },
];

export const global = {
  assumptions: [
    { key: 'usable_fraction', value: 0.9 },
    { key: 'rte_ac', value: 0.85 },
    { key: 'shave_capture', value: 0.8 },
    { key: 'dr_performance', value: 0.9 },
    { key: 'cp_hit_rate', value: 0.8 },
    { key: 'cp_dispatch_hours', value: 3 },
    { key: 'event_load_fraction', value: 0.85 },
    { key: 'arbitrage_capture', value: 0.85 },
    { key: 'shave_days_per_year', value: 250 },
    { key: 'include_cp', value: true },
    { key: 'incentives_reduce_itc_basis', value: true },
    { key: 'om_usd_per_kw_yr', value: 10 },
    { key: 'degradation_pct_yr', value: 2 },
    { key: 'escalation_pct_yr', value: 2 },
    { key: 'discount_rate_pct', value: 8 },
    { key: 'analysis_years', value: 10 },
  ],
  programs: [
    { id: 'fed-itc', name: 'Federal ITC', category: 'tax', status: 'open', utility_ids: [], valuation: { method: 'pct_of_cost', rate: 0.3 }, confidence: 'high' },
  ],
  site_constraints: [
    { id: 'nfpa-unit', rule_type: 'unit_max_kwh', title: 'Unit size', rule: 'Max 50 kWh per unit without large-scale testing.', threshold: { metric: 'kWh', value: 50 } },
    { id: 'nfpa-indoor', rule_type: 'indoor_max_kwh', title: 'Indoor aggregate', rule: 'Max 600 kWh Li-ion per fire area.', threshold: { metric: 'kWh', value: 600 } },
  ],
};

export const panel = {
  personas: [
    { id: 'bess-ix', kind: 'specialist' },
    { id: 'permitting', kind: 'specialist' },
    { id: 'constellation', kind: 'market' },
    { id: 'test-utility', kind: 'utility', jurisdictions: ['TEST'], utility_ids: ['test-util'] },
  ],
};

export const jurisdiction = {
  code: 'TEST',
  utilities: [{ id: 'test-util', name: 'Test Utility', interconnection: { tracks: [{ name: 'Simplified', max_kw: 25 }, { name: 'Expedited', max_kw: 500 }] } }],
  tariffs: [
    {
      id: 'test-ncp',
      utility_id: 'test-util',
      name: 'Test NCP rate',
      applicability: { min_kw: 100, max_kw: null },
      confidence: 'high',
      demand_charges: [{ label: 'Distribution', rate_usd_per_kw_month: 20, basis: 'ncp_monthly', months: [], window: null }],
      coincident_peak_charges: [{ type: 'capacity_tag', est_value_usd_per_kw_year: 100, passthrough: 'supply' }],
      arbitrage: [],
    },
    {
      id: 'test-tou',
      utility_id: 'test-util',
      name: 'Test TOU rate',
      confidence: 'medium',
      demand_charges: [
        { label: 'Facilities', rate_usd_per_kw_month: 20, basis: 'ncp_monthly', months: [] },
        { label: 'Summer on-peak', rate_usd_per_kw_month: 25, basis: 'tou_window', months: [6, 7, 8, 9], window: { start: 16, end: 21 } },
      ],
      arbitrage: [{ label: 'Summer', months: [6, 7, 8, 9], peak_window: { start: 16, end: 21 }, peak_price: 0.4, offpeak_price: 0.15, days: 'all' }],
    },
  ],
  programs: [
    {
      id: 'test-dr',
      name: 'Test daily dispatch',
      category: 'demand_response',
      status: 'open',
      utility_ids: ['test-util'],
      eligibility: {},
      valuation: { method: 'per_kw_season', rate: 200, duration_basis_hr: 3 },
      stacking: { conflicts_with: ['test-dr-alt'] },
      confidence: 'high',
    },
    {
      id: 'test-dr-alt',
      name: 'Test alternative DR',
      category: 'demand_response',
      status: 'open',
      utility_ids: [],
      eligibility: { min_kw: 100, requires_aggregator_or_csp: true },
      valuation: { method: 'per_kw_month', rate: 5, months_per_year: 5, duration_basis_hr: 4 },
      stacking: { conflicts_with: ['test-dr'] },
      confidence: 'medium',
    },
    {
      id: 'test-upfront',
      name: 'Test upfront',
      category: 'upfront_incentive',
      status: 'open',
      utility_ids: [],
      eligibility: {},
      valuation: { method: 'upfront_per_kwh', rate: 100, cap_pct_of_cost: 0.5, max_kwh_incentivized: 1000 },
      confidence: 'high',
    },
    { id: 'test-closed', name: 'Closed', category: 'upfront_incentive', status: 'closed', valuation: { method: 'upfront_per_kwh', rate: 500 } },
  ],
  site_constraints: [],
  panel_notes: [{ persona_id: 'test-utility', severity: 'info', topic: 't', note: 'Utility briefing' }],
};

export const data = { products, global, panel, jurisdictions: { TEST: jurisdiction } };

export const baseSite = {
  jurisdiction: 'TEST',
  utility_id: 'test-util',
  tariff_id: 'test-ncp',
  building_type: 'office',
  peak_kw: 500,
  annual_kwh: 500 * 8760 * 0.45,
  service_voltage: 480,
  phases: 3,
  service_amps: 2000,
  busbar_amps: 2000,
  main_breaker_amps: 2000,
  network_secondary: 'no',
  install_location: 'outdoor_ground',
  supply_contract: 'passthrough',
  energy_price: 0.15,
};
