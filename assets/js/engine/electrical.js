// Electrical helpers: service capacity, NEC 705.12 load-side connection limit, charging headroom.
// Pure functions — no DOM — so they run in the browser and under `node --test`.

const SQRT3 = Math.sqrt(3);

/** Apparent power (kVA) of a service from voltage (line-to-line for 3-phase) and amps. */
export function kvaFromAmps(volts, amps, phases = 3) {
  if (!isPos(volts) || !isPos(amps)) return null;
  return phases === 3 ? (SQRT3 * volts * amps) / 1000 : (volts * amps) / 1000;
}

/** Current (A) drawn by a load/inverter of `kw` at `volts`, assuming power factor `pf`. */
export function ampsFromKw(kw, volts, phases = 3, pf = 1) {
  if (!isPos(kw) || !isPos(volts)) return null;
  const kva = kw / pf;
  return phases === 3 ? (kva * 1000) / (SQRT3 * volts) : (kva * 1000) / volts;
}

/** kW deliverable at `amps` and `volts` (pf 1). */
export function kwFromAmps(amps, volts, phases = 3, pf = 1) {
  if (!isPos(amps) || !isPos(volts)) return 0;
  return (phases === 3 ? SQRT3 * volts * amps : volts * amps) * pf / 1000;
}

/**
 * NEC 705.12(B)(3)(2) "120% rule" for a load-side (backfed breaker) connection:
 *   1.25 × inverter output current + main OCPD rating ≤ 1.20 × busbar rating.
 * Returns the maximum continuous inverter current and the equivalent kW.
 * Alternatives when this binds: supply-side connection (705.11), main breaker derate,
 * a Power Control System limiting busbar current (705.13), or new switchgear.
 */
export function nec120PercentLimit({ busbarAmps, mainBreakerAmps, volts, phases = 3 }) {
  if (!isPos(busbarAmps) || !isPos(volts)) return null;
  const main = isPos(mainBreakerAmps) ? mainBreakerAmps : busbarAmps;
  const maxBackfeedBreakerAmps = Math.max(0, 1.2 * busbarAmps - main);
  const maxInverterAmps = maxBackfeedBreakerAmps / 1.25;
  return {
    maxBackfeedBreakerAmps,
    maxInverterAmps,
    maxInverterKw: kwFromAmps(maxInverterAmps, volts, phases),
  };
}

/**
 * Charging headroom on the existing service. Service conductors/equipment are sized so continuous
 * load ≤ 80% of rating (NEC 125% continuous-load sizing). Charging is a continuous load.
 * `loadAtChargeKw` is the site load when the battery charges (overnight load if charging is scheduled;
 * site peak if charging is uncontrolled).
 */
export function chargingHeadroomKw({ serviceKva, loadAtChargeKw, continuousFactor = 0.8, pf = 0.95 }) {
  if (!isPos(serviceKva)) return null;
  return serviceKva * pf * continuousFactor - (loadAtChargeKw || 0);
}

function isPos(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}
