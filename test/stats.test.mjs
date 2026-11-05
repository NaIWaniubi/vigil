import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wilson, kappa, outcomeConsistency, meanStd, costGrowth, pearson, spearman,
  positionBias, verbosityBias,
} from '../stats/index.mjs';
import { modelProfiles, stability, conflictEffect, neglectIndependence } from '../stats/aggregate.mjs';

test('wilson stays in range and widens for small n', () => {
  assert.deepEqual(wilson(0, 0), [0, 1]);
  const [lo, hi] = wilson(7, 8);
  assert.ok(lo > 0 && hi < 1);
  assert.ok(lo < 7 / 8 && hi > 7 / 8);
  const wide = wilson(1, 2);
  const narrow = wilson(50, 100);
  assert.ok(wide[1] - wide[0] > narrow[1] - narrow[0]);
});

test('kappa is 1 for identical, 0 for chance, negative for systematic disagreement', () => {
  assert.equal(kappa(['a', 'b', 'a'], ['a', 'b', 'a']), 1);
  assert.equal(kappa(['a', 'a', 'b', 'b'], ['a', 'b', 'a', 'b']), 0);
  assert.ok(kappa(['a', 'a', 'b', 'b'], ['b', 'b', 'a', 'a']) < 0);
  assert.throws(() => kappa(['a'], []), /equal-length/);
});

test('outcomeConsistency is 1 for stable and 0 for a coin flip', () => {
  assert.equal(outcomeConsistency(['win', 'win', 'win']), 1);
  assert.equal(outcomeConsistency(['win', 'loss']), 0);
  assert.ok(outcomeConsistency(['win', 'win', 'loss']) > 0);
});

test('meanStd uses sample variance', () => {
  const r = meanStd([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(r.mean, 5);
  assert.ok(Math.abs(r.std - 2.13809) < 0.001);
  assert.equal(meanStd([]).n, 0);
});

test('costGrowth recovers a known exponential multiplier', () => {
  const points = [1, 2, 3, 4, 5].map((depth) => ({ depth, cost: 10 * 1.25 ** depth }));
  const fit = costGrowth(points);
  assert.ok(Math.abs(fit.multiplier - 1.25) < 1e-6, `got ${fit.multiplier}`);
  assert.ok(fit.r2 > 0.999);
  assert.equal(costGrowth([{ depth: 1, cost: 5 }]).multiplier, null);
});

test('costGrowth reports flat cost as multiplier 1', () => {
  const fit = costGrowth([1, 2, 3].map((depth) => ({ depth, cost: 100 })));
  assert.ok(Math.abs(fit.multiplier - 1) < 1e-9);
});

test('pearson and spearman detect monotonic relations', () => {
  assert.ok(Math.abs(pearson([1, 2, 3], [2, 4, 6]) - 1) < 1e-9);
  assert.ok(Math.abs(pearson([1, 2, 3], [6, 4, 2]) + 1) < 1e-9);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null, 'zero variance is undefined, not 0');
  // Spearman sees a non-linear but monotonic relation as perfect.
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [1, 4, 9, 16]) - 1) < 1e-9);
});

test('spearman handles ties with average ranks', () => {
  const r = spearman([1, 2, 2, 3], [1, 2, 3, 4]);
  assert.ok(r > 0.8 && r <= 1);
});

test('bias helpers report null when nothing was decided', () => {
  assert.equal(positionBias(0, 0).rate, null);
  assert.equal(positionBias(7, 10).rate, 0.7);
  assert.equal(positionBias(5, 10).deviation, 0);
  assert.equal(verbosityBias(8, 10).rate, 0.8);
});

const row = (over = {}) => ({
  taskId: 't1', model: 'm', rep: 1, status: 'completed',
  config: { conflict: 'none', obligation: 'off', depth: 6 },
  terminal: { reason: 'goal_met' },
  profile: { reached: 6, passed: 6, compliant: true, obligationsDead: [], ticks: 20, totalConstraints: 6 },
  records: [], turns: [], actionLog: [],
  ...over,
});

test('infra errors are excluded, never scored as losses', () => {
  const rows = [row(), row({ status: 'error', terminal: null, profile: null })];
  const [p] = modelProfiles(rows).filter((x) => x.track === 'raw');
  assert.equal(p.cells, 1);
  assert.equal(p.winRate, 1);
  assert.equal(p.excludedInfraErrors, 1);
});

test('non-compliant runs appear in raw but not compliant', () => {
  const rows = [row(), row({ profile: { ...row().profile, compliant: false } })];
  const raw = modelProfiles(rows).find((p) => p.track === 'raw');
  const comp = modelProfiles(rows).find((p) => p.track === 'compliant');
  assert.equal(raw.cells, 2);
  assert.equal(comp.cells, 1);
  assert.equal(raw.nonCompliant, 1);
});

test('stability flags coin-flip cells', () => {
  const rows = [
    row({ rep: 1, terminal: { reason: 'goal_met' } }),
    row({ rep: 2, terminal: { reason: 'step_budget' } }),
  ];
  const s = stability(rows);
  assert.equal(s.cellsWithRepeats, 1);
  assert.equal(s.coinFlip, 1);
  assert.equal(s.meanConsistency, 0);
});

test('conflictEffect detects rank reversal', () => {
  const rows = [
    row({ model: 'a', config: { conflict: 'none' }, terminal: { reason: 'goal_met' } }),
    row({ model: 'a', config: { conflict: 'coupled' }, terminal: { reason: 'step_budget' } }),
    row({ model: 'b', config: { conflict: 'none' }, terminal: { reason: 'step_budget' } }),
    row({ model: 'b', config: { conflict: 'coupled' }, terminal: { reason: 'goal_met' } }),
  ];
  const c = conflictEffect(rows);
  assert.deepEqual(c.rankNone, ['a', 'b']);
  assert.deepEqual(c.rankCoupled, ['b', 'a']);
  assert.equal(c.reordered, true);
  assert.equal(c.rankCorrelation, -1);
});

test('neglectIndependence counts max-progress-but-died cells', () => {
  const rows = [
    row({ config: { obligation: 'decay' }, profile: { ...row().profile, reached: 6, passed: 6, obligationsDead: ['lantern'] } }),
    row({ config: { obligation: 'decay' }, profile: { ...row().profile, reached: 6, passed: 3, obligationsDead: [] } }),
  ];
  const n = neglectIndependence(rows);
  assert.equal(n.n, 2);
  assert.equal(n.maxProgressButDied, 1, 'the H2 signature: full progress, still died');
});

// ---------------------------------------------------------------------------
// Slice S1: bootstrap confidence intervals
// ---------------------------------------------------------------------------
import { bootstrapCI, bootstrapDiffCI } from '../stats/inference.mjs';

const meanOf = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
// A deterministic sample whose population mean is exactly 0.5 (uniform grid).
const uniformGrid = Array.from({ length: 100 }, (_, i) => i / 99);

test('bootstrapCI is deterministic for a fixed seed', () => {
  const a = bootstrapCI(uniformGrid, meanOf, { iterations: 2000, seed: 12345 });
  const b = bootstrapCI(uniformGrid, meanOf, { iterations: 2000, seed: 12345 });
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a).sort(), ['hi', 'lo', 'point']);
  const c = bootstrapCI(uniformGrid, meanOf, { iterations: 2000, seed: 54321 });
  assert.notDeepEqual(a, c, 'a different seed must move the resampled bounds');
});

test('bootstrapCI brackets the true mean of a known distribution', () => {
  const { lo, hi, point } = bootstrapCI(uniformGrid, meanOf, { iterations: 5000, seed: 7 });
  assert.ok(Math.abs(point - 0.5) < 1e-12, 'point is the statistic on the observed sample');
  assert.ok(lo < 0.5 && hi > 0.5, `CI [${lo},${hi}] must bracket the true mean 0.5`);
  assert.ok(lo > 0.4 && hi < 0.6, 'with n=100 the 95% CI should be fairly tight');
});

test('bootstrapCI widens as alpha falls; degenerate samples collapse', () => {
  const ci90 = bootstrapCI(uniformGrid, meanOf, { alpha: 0.10, iterations: 4000, seed: 9 });
  const ci99 = bootstrapCI(uniformGrid, meanOf, { alpha: 0.01, iterations: 4000, seed: 9 });
  assert.ok(ci90.lo >= ci99.lo, '90% lower bound cannot be below the 99% one');
  assert.ok(ci90.hi <= ci99.hi, '90% upper bound cannot be above the 99% one');

  const single = bootstrapCI([0.7], meanOf, { iterations: 100, seed: 1 });
  assert.deepEqual(single, { lo: 0.7, hi: 0.7, point: 0.7 });
  assert.throws(() => bootstrapCI([], meanOf), /non-empty/);
  assert.throws(() => bootstrapCI([1, 2], meanOf, { alpha: 1.5 }), /alpha/);
  assert.throws(() => bootstrapCI([1, 2], meanOf, { iterations: 0 }), /iterations/);
});

test('bootstrapDiffCI recovers the difference of two proportions', () => {
  // 0.50 vs 0.25, n=40 each.
  const a = [...Array(20).fill(1), ...Array(20).fill(0)];
  const b = [...Array(10).fill(1), ...Array(30).fill(0)];
  const r = bootstrapDiffCI(a, b, { iterations: 5000, seed: 2026 });
  assert.equal(r.point, 0.25);
  assert.ok(r.lo < 0.25 && r.hi > 0.25, `CI [${r.lo},${r.hi}] must bracket the point estimate`);
  assert.ok(r.lo >= -1 && r.hi <= 1);
  assert.deepEqual(r, bootstrapDiffCI(a, b, { iterations: 5000, seed: 2026 }));

  // Perfect separation collapses to a point mass at 1.
  const p = bootstrapDiffCI([1, 1, 1, 1, 1], [0, 0, 0, 0, 0], { iterations: 500, seed: 3 });
  assert.deepEqual(p, { lo: 1, hi: 1, point: 1 });
  assert.throws(() => bootstrapDiffCI([], [1]), /non-empty/);
});

// ---------------------------------------------------------------------------
// Slice S2: power and minimum detectable effect
// ---------------------------------------------------------------------------
import { powerTwoProportions, minNForEffect } from '../stats/inference.mjs';

test('powerTwoProportions is monotone in n and matches textbook limits', () => {
  const powers = [1, 5, 10, 20, 40, 80, 160].map((n) =>
    powerTwoProportions({ p1: 0.3, p2: 0.6, n, alpha: 0.05 }));
  for (let i = 1; i < powers.length; i++) {
    assert.ok(powers[i] >= powers[i - 1], `power must not fall with n: ${powers}`);
  }
  assert.ok(powers[0] < 0.1, 'n=1 cannot detect a 30pp effect');
  assert.ok(powers[powers.length - 1] > 0.99, 'n=160 should be near-certain');
  // A symmetric comparison gives the same power in either direction.
  const ab = powerTwoProportions({ p1: 0.3, p2: 0.6, n: 50 });
  const ba = powerTwoProportions({ p1: 0.6, p2: 0.3, n: 50 });
  assert.ok(Math.abs(ab - ba) < 1e-12);
});

test('powerTwoProportions returns alpha for a true null', () => {
  const p = powerTwoProportions({ p1: 0.5, p2: 0.5, n: 100, alpha: 0.05 });
  assert.ok(Math.abs(p - 0.05) < 0.005, `null power should equal alpha, got ${p}`);
  // A stricter alpha lowers power at fixed n.
  const lenient = powerTwoProportions({ p1: 0.3, p2: 0.6, n: 20, alpha: 0.10 });
  const strict = powerTwoProportions({ p1: 0.3, p2: 0.6, n: 20, alpha: 0.01 });
  assert.ok(lenient > strict);
});

test('minNForEffect round-trips through powerTwoProportions', () => {
  const n = minNForEffect({ p1: 0.3, p2: 0.6, alpha: 0.05, power: 0.8 });
  assert.ok(Number.isInteger(n), `required n must be an integer, got ${n}`);
  const atN = powerTwoProportions({ p1: 0.3, p2: 0.6, n, alpha: 0.05 });
  const belowN = powerTwoProportions({ p1: 0.3, p2: 0.6, n: n - 1, alpha: 0.05 });
  assert.ok(atN >= 0.8, `power at the returned n must reach the target, got ${atN}`);
  assert.ok(belowN < 0.8, `n-1 must fall short, got ${belowN}`);
  assert.ok(n >= 30 && n <= 60, `30pp at 80% power is ~40-50 per group, got ${n}`);
  assert.equal(minNForEffect({ p1: 0.4, p2: 0.4 }), Infinity, 'no n detects a zero effect');
  assert.throws(() => powerTwoProportions({ p1: 1.2, p2: 0.5, n: 10 }), /p1/);
  assert.throws(() => powerTwoProportions({ p1: 0.5, p2: 0.5, n: 0 }), /n/);
});

// ---------------------------------------------------------------------------
// Slice S3: multiple comparisons
// ---------------------------------------------------------------------------
import { holmBonferroni } from '../stats/inference.mjs';

test('holmBonferroni matches a hand-checked example', () => {
  // sorted: 0.01 -> 3x = 0.03; 0.03 -> 2x = 0.06; 0.04 -> max(0.06, 1x) = 0.06
  const adj = holmBonferroni([0.01, 0.04, 0.03]);
  assert.ok(Math.abs(adj[0] - 0.03) < 1e-12, `got ${adj}`);
  assert.ok(Math.abs(adj[1] - 0.06) < 1e-12, `got ${adj}`);
  assert.ok(Math.abs(adj[2] - 0.06) < 1e-12, `got ${adj}`);
  assert.deepEqual(holmBonferroni([]), []);
  assert.deepEqual(holmBonferroni([0.02]), [0.02]);
});

test('holmBonferroni is never below the raw p-value and stays in [0,1]', () => {
  const raw = [0.9, 0.001, 0.2, 0.049, 0.5];
  const adj = holmBonferroni(raw);
  for (let i = 0; i < raw.length; i++) {
    assert.ok(adj[i] >= raw[i] - 1e-12, `adjusted ${adj[i]} < raw ${raw[i]}`);
    assert.ok(adj[i] <= 1);
  }
  const allShared = holmBonferroni([0.02, 0.02, 0.02]);
  assert.deepEqual(allShared, [0.06, 0.06, 0.06]);
  assert.throws(() => holmBonferroni([0.5, 1.2]), /p-value/);
});

// ---------------------------------------------------------------------------
// Slice S4: stats-report CLI
// ---------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { twoProportionPValue } from '../stats/inference.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('twoProportionPValue matches a hand-computed pooled z-test', () => {
  // 9/10 vs 3/10 -> pooled 0.6, se=sqrt(0.6*0.4*0.2)=0.2191, z=2.7386 -> p~0.0062
  const p = twoProportionPValue({ winsA: 9, nA: 10, winsB: 3, nB: 10 });
  assert.ok(Math.abs(p - 0.00617) < 0.0005, `got ${p}`);
  assert.ok(Math.abs(twoProportionPValue({ winsA: 5, nA: 10, winsB: 5, nB: 10 }) - 1) < 1e-6);
  assert.throws(() => twoProportionPValue({ winsA: 11, nA: 10, winsB: 0, nB: 10 }), /winsA/);
});

test('stats-report CLI writes JSON+markdown with Wilson, bootstrap, Holm and verdict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-stats-report-'));
  try {
    const rows = [];
    for (let i = 0; i < 4; i++) {
      rows.push({
        taskId: `t${i}`, model: 'alpha', status: 'completed',
        terminal: { reason: i < 3 ? 'goal_met' : 'step_budget' },
      });
    }
    for (let i = 0; i < 4; i++) {
      rows.push({
        taskId: `t${i}`, model: 'beta', status: 'completed',
        terminal: { reason: i < 1 ? 'goal_met' : 'step_budget' },
      });
    }
    rows.push({ taskId: 't9', model: 'beta', status: 'error', terminal: null });
    writeFileSync(join(dir, 'results.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    writeFileSync(join(dir, 'report.json'), JSON.stringify({
      protocol: { promptVersion: 'test-v1', engineVersion: '0.0.0', temperature: 0, reps: 1, family: 'rush' },
      profiles: [
        { model: 'alpha', track: 'raw', cells: 4, wins: 3, winRate: 0.75 },
        { model: 'beta', track: 'raw', cells: 4, wins: 1, winRate: 0.25 },
      ],
    }));

    const cli = join(REPO_ROOT, 'scripts', 'stats-report.mjs');
    const run = spawnSync(process.execPath, [cli, dir], { encoding: 'utf8' });
    assert.equal(run.status, 0, `CLI failed:\n${run.stderr}`);
    assert.match(run.stdout, /verdict: underpowered/);

    // Derived reports are written OUTSIDE the run bundle (docs/stats/<slug>-stats.*)
    // so a bundle's MANIFEST stays valid. Mirror the CLI's slug rule here.
    const slug = basename(dir).replace(/[^a-zA-Z0-9._-]/g, '_');
    const jsonPath = join(REPO_ROOT, 'docs', 'stats', `${slug}-stats.json`);
    const mdPath = join(REPO_ROOT, 'docs', 'stats', `${slug}-stats.md`);
    assert.ok(existsSync(jsonPath) && existsSync(mdPath), 'both report files must be written');
    const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(report.verdict, 'underpowered');
    assert.equal(report.models.length, 2);
    assert.equal(report.pairwise.length, 1);
    for (const m of report.models) {
      assert.equal(m.wilsonCI95.length, 2);
      assert.equal(m.bootstrapCI95.length, 2);
      assert.ok(m.bootstrapCI95[0] <= m.bootstrapCI95[1]);
    }
    assert.ok(report.pairwise[0].holmAdjusted >= report.pairwise[0].pValue);
    assert.equal(report.pairwise[0].significant, false);
    assert.equal(report.dataQuality.infraErrors, 1);
    assert.equal(report.power.requiredNPerGroup, 42);
    assert.ok(report.power.achievedN < report.power.requiredNPerGroup);
    const md = readFileSync(mdPath, 'utf8');
    assert.match(md, /underpowered/);
    assert.match(md, /Pairwise/);

    // Seed derivation is fixed: a second run must reproduce every interval.
    const again = spawnSync(process.execPath, [cli, dir], { encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    const report2 = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.deepEqual(report2.models, report.models);
    assert.deepEqual(report2.pairwise, report.pairwise);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stats-report CLI refuses a directory without results.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-stats-empty-'));
  try {
    const cli = join(REPO_ROOT, 'scripts', 'stats-report.mjs');
    const run = spawnSync(process.execPath, [cli, dir], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /results\.jsonl/);
    const usage = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Slice S5: judge methodology namespace
// ---------------------------------------------------------------------------
import { judgeMethodology } from '../stats/judge.mjs';

test('judge metrics are namespaced as methodology, not scoring', () => {
  assert.deepEqual(
    Object.keys(judgeMethodology).sort(),
    ['kappa', 'positionBias', 'verbosityBias'],
    'only the blind-judge utilities belong in this namespace',
  );
  assert.equal(judgeMethodology.kappa(['a', 'b'], ['a', 'b']), 1);
  assert.equal(judgeMethodology.positionBias(7, 10).rate, 0.7);
  assert.equal(judgeMethodology.verbosityBias(8, 10).rate, 0.8);
  assert.ok(Object.isFrozen(judgeMethodology));
});

test('stats/index.mjs remains the single public entry point for inference', async () => {
  const entry = await import('../stats/index.mjs');
  for (const name of [
    'wilson', 'bootstrapCI', 'bootstrapDiffCI', 'powerTwoProportions',
    'minNForEffect', 'holmBonferroni', 'twoProportionPValue',
  ]) {
    assert.equal(typeof entry[name], 'function', `${name} must be exported from stats/index.mjs`);
  }
});