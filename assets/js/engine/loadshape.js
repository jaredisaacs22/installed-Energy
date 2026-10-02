// Design-day load shapes and the peak-shaving estimator.
//
// Without interval data we estimate achievable demand reduction on a representative *peak* weekday.
// Shapes are normalized hourly fractions of the day's peak (1.0 = peak hour). They are generic
// engineering approximations of commercial building-type peak days, NOT measured data. For bankable
// numbers, paste a peak-day profile from your interval model (24 hourly or 96 15-minute values) or
// override the shave kW per configuration.

export const BUILDING_SHAPES = {
  office: {
    label: 'Office',
    shape: [0.35, 0.34, 0.34, 0.34, 0.36, 0.42, 0.55, 0.72, 0.85, 0.92, 0.96, 0.98, 1.0, 1.0, 0.99, 0.97, 0.92, 0.82, 0.65, 0.52, 0.45, 0.4, 0.37, 0.36],
  },
  retail: {
    label: 'Retail store',
    shape: [0.3, 0.29, 0.29, 0.29, 0.3, 0.33, 0.4, 0.55, 0.75, 0.88, 0.94, 0.97, 0.99, 1.0, 1.0, 0.99, 0.97, 0.95, 0.92, 0.88, 0.75, 0.55, 0.38, 0.32],
  },
  grocery: {
    label: 'Grocery / supermarket',
    shape: [0.62, 0.6, 0.59, 0.59, 0.6, 0.64, 0.72, 0.8, 0.86, 0.9, 0.93, 0.95, 0.97, 0.98, 1.0, 1.0, 0.99, 0.97, 0.95, 0.92, 0.87, 0.8, 0.72, 0.66],
  },
  warehouse: {
    label: 'Warehouse / distribution',
    shape: [0.3, 0.3, 0.3, 0.3, 0.35, 0.55, 0.8, 0.92, 0.97, 1.0, 1.0, 0.98, 0.95, 0.98, 1.0, 0.97, 0.85, 0.6, 0.42, 0.36, 0.34, 0.32, 0.31, 0.3],
  },
  restaurant: {
    label: 'Restaurant / QSR',
    shape: [0.3, 0.28, 0.28, 0.28, 0.3, 0.38, 0.5, 0.6, 0.62, 0.65, 0.75, 0.92, 1.0, 0.95, 0.8, 0.75, 0.82, 0.95, 1.0, 0.97, 0.85, 0.65, 0.45, 0.35],
  },
  manufacturing: {
    label: 'Light manufacturing (2 shifts)',
    shape: [0.45, 0.44, 0.44, 0.44, 0.48, 0.62, 0.85, 0.95, 0.98, 1.0, 1.0, 0.97, 0.94, 0.98, 1.0, 0.99, 0.95, 0.88, 0.8, 0.75, 0.7, 0.62, 0.52, 0.47],
  },
  school: {
    label: 'School',
    shape: [0.25, 0.25, 0.25, 0.25, 0.27, 0.35, 0.6, 0.85, 0.95, 1.0, 1.0, 0.98, 0.97, 0.95, 0.85, 0.65, 0.48, 0.4, 0.35, 0.32, 0.3, 0.28, 0.27, 0.26],
  },
  hotel: {
    label: 'Hotel / lodging',
    shape: [0.62, 0.6, 0.58, 0.57, 0.58, 0.62, 0.72, 0.8, 0.82, 0.83, 0.85, 0.88, 0.9, 0.92, 0.94, 0.96, 0.98, 1.0, 1.0, 0.98, 0.94, 0.86, 0.76, 0.67],
  },
  cold_storage: {
    label: 'Cold storage / refrigerated warehouse',
    shape: [0.8, 0.8, 0.8, 0.8, 0.8, 0.82, 0.85, 0.88, 0.92, 0.95, 0.97, 0.99, 1.0, 1.0, 1.0, 0.99, 0.97, 0.94, 0.9, 0.87, 0.85, 0.83, 0.82, 0.81],
  },
};

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

/** Annual load factor = annual kWh / (peak kW × 8760). */
export function loadFactor(peakKw, annualKwh) {
  if (!(peakKw > 0) || !(annualKwh > 0)) return null;
  return Math.min(1, annualKwh / (peakKw * 8760));
}

/**
 * Build a design-day profile in kW.
 * - `custom`: array of 24 (hourly) or 96 (15-min) kW values from interval data → used as-is.
 * - otherwise a building shape, flattened/sharpened so the peak-day load factor is consistent with the
 *   site's annual load factor: dayLF ≈ 1 − 0.75 × (1 − annualLF).
 * Returns { kw: number[], dtHours, source, dayLoadFactor }.
 */
export function designDayProfile({ peakKw, annualKwh, buildingType = 'office', custom = null }) {
  if (Array.isArray(custom) && (custom.length === 24 || custom.length === 96)) {
    const kw = custom.map((x) => Math.max(0, Number(x) || 0));
    const pk = Math.max(...kw);
    return { kw, dtHours: 24 / kw.length, source: 'custom', dayLoadFactor: pk > 0 ? mean(kw) / pk : null };
  }
  const base = (BUILDING_SHAPES[buildingType] || BUILDING_SHAPES.office).shape;
  let shape = base.slice();
  const lf = loadFactor(peakKw, annualKwh);
  if (lf != null) {
    const target = Math.min(0.95, Math.max(0.3, 1 - 0.75 * (1 - lf)));
    const lf0 = mean(base);
    const alpha = Math.min(1.8, Math.max(0.4, (1 - target) / (1 - lf0)));
    shape = base.map((s) => Math.max(0.05, 1 - alpha * (1 - s)));
  }
  const kw = shape.map((s) => s * peakKw);
  return { kw, dtHours: 1, source: lf != null ? 'shape+loadfactor' : 'shape', dayLoadFactor: mean(shape) };
}

/** Convert a window {start, end} in hours (end exclusive, may wrap midnight) into a boolean mask. */
export function windowMask(len, dtHours, window) {
  const mask = new Array(len).fill(false);
  if (Array.isArray(window)) {
    if (!window.length) return mask.fill(true);
    const parts = window.map((w) => windowMask(len, dtHours, w));
    return mask.map((_, i) => parts.some((p) => p[i]));
  }
  if (!window || window.start == null || window.end == null) return mask.fill(true);
  for (let i = 0; i < len; i++) {
    const h = i * dtHours;
    const { start, end } = window;
    mask[i] = start <= end ? h >= start && h < end : h >= start || h < end;
  }
  return mask;
}

/**
 * Demand reduction on a DR/performance event day. The battery delivers `eventKw` flat across `block`.
 * When `battery` ({ kw, usableKwh, rte }) is given, energy and kW left over after the event are used to
 * shave outside it (no charging during the event, and the event energy must also be recharged without a
 * new peak). Without `battery`, only the event discharge itself counts. Returns {id: kW reduction}.
 */
export function eventDayReduction(profile, components, block, eventKw, battery = null) {
  const P = profile.kw;
  const n = P.length;
  const dt = profile.dtHours;
  const ev = windowMask(n, dt, block);
  const eventD = P.map((p, i) => (ev[i] ? Math.min(eventKw, p) : 0));
  const net = P.map((p, i) => p - eventD[i]);
  const eventKwh = eventD.reduce((s, d) => s + d * dt, 0);
  const out = {};
  const peaks = components.map((c) => {
    const mask = windowMask(n, dt, c.window);
    let peak = 0;
    let after = 0;
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      peak = Math.max(peak, P[i]);
      after = Math.max(after, net[i]);
    }
    out[c.id] = Math.max(0, peak - after);
    return { peak, after };
  });
  if (!battery || !(battery.usableKwh > eventKwh + 1e-9) || !(battery.kw > 0)) return out;
  const opt = optimizeShave({ kw: net, dtHours: dt }, components, {
    kw: battery.kw,
    chargeKw: battery.chargeKw,
    usableKwh: battery.usableKwh - eventKwh,
    rte: battery.rte,
    kwLimit: eventD.map((d) => Math.max(0, battery.kw - d)),
    noCharge: ev,
    extraChargeKwh: eventKwh,
  });
  components.forEach((c, k) => (out[c.id] = Math.max(0, peaks[k].peak - (peaks[k].after - (opt.deltas[c.id] || 0)))));
  return out;
}

/**
 * Jointly optimize demand reduction across several demand-charge components on one design day.
 *
 * components: [{ id, rate, window: {start,end} | null }]  (rate = $/kW-month; window null = all hours)
 * Battery limits: kw (discharge), chargeKw (charge; defaults to kw), usableKwh (AC energy deliverable),
 * rte (for recharge energy).
 * Greedy marginal-value search: repeatedly lowers the cap of the component with the best $/kWh until the
 * battery runs out of kW, energy, or recharge room (recharging must not create a new peak), or the next
 * step saves less than the monthly cost of the extra round-trip losses (energyCostPerKwhMonth).
 * Optional: kwLimit (per-interval discharge limit), noCharge (intervals where charging is not allowed),
 * extraChargeKwh (AC energy already discharged elsewhere that must also be recharged).
 *
 * Returns { deltas: {id: kW}, energyKwh, maxDischargeKw, feasibleRecharge }
 */
export function optimizeShave(profile, components, { kw, chargeKw = null, usableKwh, rte = 0.85, steps = 400, energyCostPerKwhMonth = 0, kwLimit = null, noCharge = null, extraChargeKwh = 0 }) {
  const ck = chargeKw > 0 ? chargeKw : kw;
  const P = profile.kw;
  const dt = profile.dtHours;
  const n = P.length;
  const comps = components
    .filter((c) => c.rate > 0)
    .map((c) => {
      const mask = windowMask(n, dt, c.window);
      const peak = Math.max(0, ...P.filter((_, i) => mask[i]));
      return { ...c, mask, peak, delta: 0 };
    })
    .filter((c) => c.peak > 0);
  const result = { deltas: {}, energyKwh: 0, maxDischargeKw: 0, feasibleRecharge: true, discharge: new Array(P.length).fill(0), caps: new Array(P.length).fill(Infinity) };
  components.forEach((c) => (result.deltas[c.id] = 0));
  if (!comps.length || !(kw > 0) || !(usableKwh > 0)) return result;

  const dayPeak = Math.max(...P);
  const step = dayPeak / steps;

  const evaluate = (deltas) => {
    // cap per interval = min over components covering it of (componentPeak − delta)
    let energy = 0;
    let maxD = 0;
    let overLimit = false;
    const discharge = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let cap = Infinity;
      comps.forEach((c, k) => {
        if (c.mask[i]) cap = Math.min(cap, c.peak - deltas[k]);
      });
      const d = cap === Infinity ? 0 : Math.max(0, P[i] - cap);
      discharge[i] = d;
      energy += d * dt;
      if (d > maxD) maxD = d;
      if (kwLimit && d > kwLimit[i] + 1e-9) overLimit = true;
    }
    // Recharge in intervals with no discharge, without exceeding any covering cap (no new peaks).
    let room = 0;
    for (let i = 0; i < n; i++) {
      if (discharge[i] > 0 || noCharge?.[i]) continue;
      let cap = Infinity;
      comps.forEach((c, k) => {
        if (c.mask[i]) cap = Math.min(cap, c.peak - deltas[k]);
      });
      const headroom = cap === Infinity ? ck : Math.max(0, cap - P[i]);
      room += Math.min(ck, headroom) * dt;
    }
    const needCharge = (energy + extraChargeKwh) / rte;
    return { energy, maxD, overLimit, rechargeOk: room + 1e-9 >= needCharge, discharge };
  };

  const deltas = comps.map(() => 0);
  let current = evaluate(deltas);
  for (let iter = 0; iter < steps * comps.length; iter++) {
    let best = -1;
    let bestRatio = -Infinity;
    let bestEval = null;
    comps.forEach((c, k) => {
      if (deltas[k] + step > c.peak) return;
      const trial = deltas.slice();
      trial[k] += step;
      const ev = evaluate(trial);
      if (ev.maxD > kw + 1e-9 || ev.overLimit || ev.energy > usableKwh + 1e-9 || !ev.rechargeOk) return;
      const dE = ev.energy - current.energy;
      // Stop shaving once a step saves less per month than the round-trip energy it costs to cycle.
      if (energyCostPerKwhMonth > 0 && c.rate * step < dE * energyCostPerKwhMonth) return;
      const ratio = (c.rate * step) / Math.max(dE, 1e-6);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = k;
        bestEval = ev;
      }
    });
    if (best < 0) break;
    deltas[best] += step;
    current = bestEval;
  }
  comps.forEach((c, k) => (result.deltas[c.id] = deltas[k]));
  result.discharge = current.discharge || result.discharge;
  result.caps = P.map((_, i) => {
    let cap = Infinity;
    comps.forEach((c, k) => {
      if (c.mask[i]) cap = Math.min(cap, c.peak - deltas[k]);
    });
    return cap;
  });
  result.energyKwh = current.energy;
  result.maxDischargeKw = current.maxD;
  result.feasibleRecharge = current.rechargeOk;
  return result;
}

// ---- Interval data: hold monthly demand caps on every day of the month ----

/** Peak of each component's window on a profile: {id: kW}. */
export function componentPeaks(profile, components) {
  const out = {};
  for (const c of components) {
    const mask = windowMask(profile.kw.length, profile.dtHours, c.window);
    let pk = 0;
    profile.kw.forEach((v, i) => {
      if (mask[i] && Number.isFinite(v) && v > pk) pk = v;
    });
    out[c.id] = pk;
  }
  return out;
}

/** Per-interval cap = min over components covering the interval of (component peak − reduction). */
export function capsAt(n, dtHours, components, peaks, deltas, scale = 1) {
  const caps = new Array(n).fill(Infinity);
  for (const c of components) {
    if (!(c.rate > 0)) continue;
    const mask = windowMask(n, dtHours, c.window);
    const cap = peaks[c.id] - scale * (deltas[c.id] || 0);
    for (let i = 0; i < n; i++) if (mask[i] && cap < caps[i]) caps[i] = cap;
  }
  return caps;
}

/** Discharge needed to hold `caps` on one day, and whether the battery can do it and recharge. */
export function dayUnderCaps(dayKw, caps, dtHours, battery) {
  let energy = 0;
  let maxD = 0;
  let room = 0;
  const ck = battery.chargeKw > 0 ? battery.chargeKw : battery.kw;
  for (let i = 0; i < dayKw.length; i++) {
    const p = dayKw[i];
    if (!Number.isFinite(p)) continue; // missing interval: no discharge needed, no recharge room assumed
    const d = caps[i] === Infinity ? 0 : Math.max(0, p - caps[i]);
    if (d > 0) {
      energy += d * dtHours;
      if (d > maxD) maxD = d;
    } else room += Math.min(ck, caps[i] === Infinity ? ck : Math.max(0, caps[i] - p)) * dtHours;
  }
  const ok = maxD <= battery.kw + 1e-9 && energy <= battery.usableKwh + 1e-9 && room + 1e-9 >= energy / (battery.rte || 1);
  return { energy, maxD, ok };
}

/**
 * Starting from reductions found on the month's envelope (a conservative worst case), deepen them
 * proportionally as far as the caps still hold on every actual day of the month (power, energy and
 * recharge without a new peak). If even the starting caps fail on some day, shrink instead.
 * Returns { deltas, scale }.
 */
export function deepenAcrossDays(days, envelope, components, deltas, battery) {
  const n = envelope.kw.length;
  const dt = envelope.dtHours;
  const peaks = componentPeaks(envelope, components);
  const holds = (s) => {
    const caps = capsAt(n, dt, components, peaks, deltas, s);
    return days.every((d) => dayUnderCaps(d.kw, caps, dt, battery).ok);
  };
  const active = components.filter((c) => c.rate > 0 && (deltas[c.id] || 0) > 0);
  if (!active.length) return { deltas: { ...deltas }, scale: 1 };
  let sMax = Math.min(10, ...active.map((c) => peaks[c.id] / deltas[c.id]));
  let lo;
  let hi;
  if (holds(1)) {
    lo = 1;
    hi = sMax;
    if (holds(hi)) lo = hi;
  } else {
    lo = 0;
    hi = 1;
  }
  for (let k = 0; k < 14 && hi - lo > 1e-3; k++) {
    const mid = (lo + hi) / 2;
    if (holds(mid)) lo = mid;
    else hi = mid;
  }
  const out = {};
  for (const c of components) out[c.id] = (deltas[c.id] || 0) * lo;
  return { deltas: out, scale: lo };
}

/** Energy (kWh) discharged across `days` to hold `caps`. */
export function energyUnderCaps(days, caps, dtHours, battery) {
  return days.reduce((s, d) => s + dayUnderCaps(d.kw, caps, dtHours, battery).energy, 0);
}
