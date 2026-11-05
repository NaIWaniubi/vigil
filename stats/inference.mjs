// Statistical inference for VIGIL. Dependency-free: the PRNG is a local
// mulberry32 copy (the engine has its own; stats must not import from tasks/ or
// engine/ so the published numbers stay reproducible in isolation).

/**
 * Mulberry32 — 32-bit seedable PRNG. Determinism is a hard requirement: a
 * bootstrap interval that moves between runs is not a scientific number.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated quantile of an ascending-sorted array. */
function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

function validateBootstrapArgs({ iterations, alpha }) {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`bootstrap iterations must be a positive integer, got ${iterations}`);
  }
  if (!(alpha > 0 && alpha < 1)) {
    throw new Error(`bootstrap alpha must be in (0,1), got ${alpha}`);
  }
}

const identity = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Percentile bootstrap confidence interval for an arbitrary statistic.
 *
 * `statistic` receives resampled arrays; the returned `point` is the statistic
 * on the observed sample (not the mean of the resamples, which would be biased
 * for non-linear statistics).
 *
 * @param {number[]} values observed sample (non-empty)
 * @param {(sample: number[]) => number} statistic
 * @param {{iterations?: number, alpha?: number, seed?: number}} [opts]
 * @returns {{lo: number, hi: number, point: number}}
 */
export function bootstrapCI(values, statistic = identity, opts = {}) {
  const { iterations = 10000, alpha = 0.05, seed = 1 } = opts;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('bootstrapCI needs a non-empty array of values');
  }
  if (typeof statistic !== 'function') {
    throw new Error('bootstrapCI needs a statistic function');
  }
  validateBootstrapArgs({ iterations, alpha });
  const point = statistic(values);
  if (!Number.isFinite(point)) {
    throw new Error('bootstrap statistic returned a non-finite value on the observed sample');
  }
  const n = values.length;
  const rand = mulberry32(seed);
  const sample = new Array(n);
  const draws = new Array(iterations);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) sample[i] = values[Math.floor(rand() * n)];
    const s = statistic(sample);
    if (!Number.isFinite(s)) {
      throw new Error('bootstrap statistic returned a non-finite value on a resample');
    }
    draws[it] = s;
  }
  draws.sort((a, b) => a - b);
  return {
    lo: quantile(draws, alpha / 2),
    hi: quantile(draws, 1 - alpha / 2),
    point,
  };
}

/**
 * Percentile bootstrap CI for the difference of two proportions
 * (mean(a) - mean(b)). Resamples each group independently. This is the
 * cross-model win-rate difference: feed 1/0 outcome arrays.
 *
 * @param {number[]} a group A outcomes (1 = win, 0 = loss)
 * @param {number[]} b group B outcomes
 * @param {{iterations?: number, alpha?: number, seed?: number}} [opts]
 * @returns {{lo: number, hi: number, point: number}}
 */
export function bootstrapDiffCI(a, b, opts = {}) {
  const { iterations = 10000, alpha = 0.05, seed = 1 } = opts;
  if (!Array.isArray(a) || a.length === 0) {
    throw new Error('bootstrapDiffCI needs a non-empty array for group a');
  }
  if (!Array.isArray(b) || b.length === 0) {
    throw new Error('bootstrapDiffCI needs a non-empty array for group b');
  }
  validateBootstrapArgs({ iterations, alpha });
  const point = identity(a) - identity(b);
  const rand = mulberry32(seed);
  const sa = new Array(a.length);
  const sb = new Array(b.length);
  const draws = new Array(iterations);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < a.length; i++) sa[i] = a[Math.floor(rand() * a.length)];
    for (let i = 0; i < b.length; i++) sb[i] = b[Math.floor(rand() * b.length)];
    draws[it] = identity(sa) - identity(sb);
  }
  draws.sort((x, y) => x - y);
  return {
    lo: quantile(draws, alpha / 2),
    hi: quantile(draws, 1 - alpha / 2),
    point,
  };
}

// --- normal approximation -------------------------------------------------

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Inverse standard normal CDF (Acklam's rational approximation). */
function normalInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function validateProportion(name, value) {
  if (!(value >= 0 && value <= 1)) {
    throw new Error(`${name} must be a proportion in [0,1], got ${value}`);
  }
}

/**
 * Two-sided power of a two-proportion test under the normal approximation.
 *
 * `n` is the per-group sample size (pass n2 for unequal allocation). This is
 * the number that exposes tiny-sample claims: with n=13 per model, only very
 * large effects are detectable at 80% power.
 *
 * @param {{p1: number, p2: number, n: number, n2?: number, alpha?: number}} args
 * @returns {number} power in [0,1]
 */
export function powerTwoProportions({ p1, p2, n, n2 = n, alpha = 0.05 } = {}) {
  validateProportion('p1', p1);
  validateProportion('p2', p2);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`n must be a positive number, got ${n}`);
  if (!Number.isFinite(n2) || n2 <= 0) throw new Error(`n2 must be a positive number, got ${n2}`);
  if (!(alpha > 0 && alpha < 1)) throw new Error(`alpha must be in (0,1), got ${alpha}`);
  const delta = Math.abs(p1 - p2);
  if (delta === 0) return alpha;
  const pooled = (p1 * n + p2 * n2) / (n + n2);
  const seNull = Math.sqrt(pooled * (1 - pooled) * (1 / n + 1 / n2));
  const seAlt = Math.sqrt((p1 * (1 - p1)) / n + (p2 * (1 - p2)) / n2);
  if (seAlt === 0) return 1;
  const zCrit = normalInv(1 - alpha / 2);
  const power = normalCdf((delta - zCrit * seNull) / seAlt)
    + normalCdf((-delta - zCrit * seNull) / seAlt);
  return Math.min(1, Math.max(0, power));
}

/**
 * Smallest per-group n that reaches `power` for the given two proportions.
 * Returns Infinity when no n can help (p1 === p2). Relies on power being
 * monotone in n, which holds for this normal approximation.
 *
 * @param {{p1: number, p2: number, alpha?: number, power?: number, maxN?: number}} args
 * @returns {number} required per-group sample size (integer), or Infinity
 */
export function minNForEffect({ p1, p2, alpha = 0.05, power = 0.8, maxN = 1e7 } = {}) {
  validateProportion('p1', p1);
  validateProportion('p2', p2);
  if (!(alpha > 0 && alpha < 1)) throw new Error(`alpha must be in (0,1), got ${alpha}`);
  if (!(power > 0 && power < 1)) throw new Error(`power must be in (0,1), got ${power}`);
  if (p1 === p2) return Infinity;
  if (powerTwoProportions({ p1, p2, n: 1, alpha }) >= power) return 1;
  let lo = 1;
  let hi = 2;
  while (powerTwoProportions({ p1, p2, n: hi, alpha }) < power) {
    lo = hi;
    hi *= 2;
    if (hi > maxN) return Infinity;
  }
  // Invariant: power(lo) < target <= power(hi).
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (powerTwoProportions({ p1, p2, n: mid, alpha }) >= power) hi = mid;
    else lo = mid;
  }
  return hi;
}