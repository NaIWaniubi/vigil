// Statistics for VIGIL. Pure functions, no dependencies.
//
// Methodology adapted from the CC0 evals toolkit of awesome-short-drama-skills
// (see NOTICE): Wilson intervals for small samples, Cohen's kappa for judge
// agreement, and explicit position/verbosity bias checks. The point is to
// publish the evaluator's OWN trustworthiness alongside the model scores.

/** Wilson score interval. Stable for small n; never escapes [0,1]. */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 1];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

/** Cohen's kappa for two equal-length label sequences. */
// JUDGE METHODOLOGY ONLY: no run pipeline calls this. See stats/judge.mjs.
export function kappa(a, b) {
  if (a.length !== b.length) throw new Error('kappa needs equal-length sequences');
  const n = a.length;
  if (n === 0) return 1;
  let same = 0;
  const ca = new Map();
  const cb = new Map();
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) same++;
    ca.set(a[i], (ca.get(a[i]) ?? 0) + 1);
    cb.set(b[i], (cb.get(b[i]) ?? 0) + 1);
  }
  const po = same / n;
  let pe = 0;
  for (const [label, count] of ca) pe += (count / n) * ((cb.get(label) ?? 0) / n);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

/**
 * Outcome consistency across K repetitions of the same cell.
 * (2p-1)^2 where p is the majority outcome share: 1 = perfectly stable,
 * 0 = a coin flip. This is the metric a single-run leaderboard hides.
 */
export function outcomeConsistency(outcomes) {
  if (!outcomes.length) return 1;
  const counts = new Map();
  for (const o of outcomes) counts.set(o, (counts.get(o) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const p = top / outcomes.length;
  return (2 * p - 1) ** 2;
}

/** Mean and sample standard deviation. */
export function meanStd(xs) {
  if (!xs.length) return { mean: 0, std: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length < 2) return { mean, std: 0, n: xs.length };
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return { mean, std: Math.sqrt(variance), n: xs.length };
}

/**
 * Fit cumulative cost against constraint depth on a log scale.
 * Returns the per-constraint multiplier exp(slope), the analogue of SoTALab's
 * "每关成本增长倍率集中在 1.12～1.37 倍". A multiplier near 1 means cost is flat;
 * above 1 means each additional rule compounds.
 */
export function costGrowth(points) {
  // points: [{ depth, cost }] with cost > 0
  const usable = points.filter((p) => p.depth > 0 && p.cost > 0);
  if (usable.length < 2) return { multiplier: null, r2: null, n: usable.length };
  const xs = usable.map((p) => p.depth);
  const ys = usable.map((p) => Math.log(p.cost));
  const { mean: mx } = meanStd(xs);
  const { mean: my } = meanStd(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return { multiplier: null, r2: null, n: usable.length };
  const slope = num / den;
  const intercept = my - slope * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < xs.length; i++) {
    ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  return {
    multiplier: Math.exp(slope),
    slope,
    r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot,
    n: usable.length,
  };
}

/** Pearson correlation, used for H2 (neglect vs main-line progress). */
export function pearson(xs, ys) {
  if (xs.length !== ys.length) throw new Error('pearson needs paired samples');
  const n = xs.length;
  if (n < 2) return null;
  const { mean: mx } = meanStd(xs);
  const { mean: my } = meanStd(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? null : num / den;
}

/** Spearman rank correlation — robust to non-linear score scales. */
export function spearman(xs, ys) {
  const rank = (arr) => {
    const sorted = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(arr.length);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[sorted[k][1]] = avg;
      i = j + 1;
    }
    return ranks;
  };
  return pearson(rank(xs), rank(ys));
}

/**
 * Position bias for paired judgements: how often the first-presented item wins.
 * 0.5 is unbiased. Reported because no agent benchmark publishes it.
 */
// JUDGE METHODOLOGY ONLY: no run pipeline calls this. See stats/judge.mjs.
export function positionBias(firstWins, decided) {
  if (!decided) return { rate: null, n: 0 };
  return { rate: firstWins / decided, n: decided, deviation: Math.abs(firstWins / decided - 0.5) };
}

/** Verbosity bias: among decided pairs, how often the longer answer won. */
// JUDGE METHODOLOGY ONLY: no run pipeline calls this. See stats/judge.mjs.
export function verbosityBias(longerWins, decided) {
  if (!decided) return { rate: null, n: 0 };
  return { rate: longerWins / decided, n: decided };
}

// Inference primitives live in ./inference.mjs (bootstrap, power/MDE, Holm).
// Re-exported so `stats/index.mjs` remains the single public entry point.
export {
  bootstrapCI,
  bootstrapDiffCI,
  powerTwoProportions,
  minNForEffect,
  holmBonferroni,
  twoProportionPValue,
  normalCdf,
} from './inference.mjs';