// Candidate battery configurations built from the product catalog (data/products.json).

/**
 * A configuration is a list of {productId, count}. Totals are computed from the catalog.
 * @returns {{id, label, items, kw, kwh, units, durationHr, installedCostUsd|null}}
 */
export function buildConfig(items, products) {
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  const clean = items.filter((it) => it.count > 0 && byId[it.productId]);
  let kw = 0;
  let kwh = 0;
  let usable = 0;
  let chargeKw = 0;
  let effWeighted = 0;
  let specKnown = true;
  let units = 0;
  let cost = 0;
  let costKnown = true;
  for (const it of clean) {
    const p = byId[it.productId];
    kw += p.kw * it.count;
    kwh += p.kwh * it.count;
    const u = typeof p.usable_kwh === 'number' ? p.usable_kwh : null;
    if (u == null || typeof p.eff_charge !== 'number' || typeof p.eff_discharge !== 'number') specKnown = false;
    // Usable kWh is stored energy; what reaches the meter is usable × discharge efficiency (workbench convention).
    usable += (u ?? 0) * (p.eff_discharge ?? 1) * it.count;
    chargeKw += (typeof p.charge_kw === 'number' ? p.charge_kw : p.kw) * it.count;
    effWeighted += (u ?? 0) * (p.eff_discharge ?? 1) * it.count * (p.eff_charge ?? 1) * (p.eff_discharge ?? 1);
    units += it.count;
    const unitCost = productCost(p);
    if (unitCost == null) costKnown = false;
    else cost += unitCost * it.count;
  }
  const id = clean.map((it) => `${it.count}x${it.productId}`).join('+') || 'none';
  const label = clean.map((it) => `${it.count} × ${byId[it.productId].label}`).join(' + ') || 'No battery';
  return {
    id,
    label,
    items: clean,
    kw,
    kwh,
    units,
    durationHr: kw > 0 ? kwh / kw : 0,
    // Product-level specs: usableKwh = AC energy deliverable from full (stored usable × discharge
    // efficiency), charge kW, round-trip efficiency. null = use the global usable_fraction / rte_ac.
    usableKwh: specKnown && units > 0 ? usable : null,
    chargeKw: units > 0 ? chargeKw : 0,
    rte: specKnown && usable > 0 ? effWeighted / usable : null,
    installedCostUsd: costKnown && units > 0 ? cost : null,
  };
}

/** Installed cost of one unit: explicit $ per unit, else $/kWh × kWh, else null. */
export function productCost(p) {
  if (typeof p.installed_cost_usd === 'number') return p.installed_cost_usd;
  if (typeof p.installed_cost_usd_per_kwh === 'number') return p.installed_cost_usd_per_kwh * p.kwh;
  return null;
}

/**
 * Homogeneous candidate configs: 1..N units of each product, where N stops once total kW exceeds the
 * site's useful discharge ceiling (non-export: battery kW above site load is stranded). Always includes
 * at least one unit of each product so small sites still see every option.
 */
export function candidateConfigs(products, { usefulKwCeiling, maxUnitsPerProduct = 8 } = {}) {
  const out = [];
  for (const p of products) {
    for (let n = 1; n <= maxUnitsPerProduct; n++) {
      if (n > 1 && usefulKwCeiling != null && p.kw * n > usefulKwCeiling) break;
      out.push(buildConfig([{ productId: p.id, count: n }], products));
    }
  }
  return out;
}
