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
  let units = 0;
  let cost = 0;
  let costKnown = true;
  for (const it of clean) {
    const p = byId[it.productId];
    kw += p.kw * it.count;
    kwh += p.kwh * it.count;
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
