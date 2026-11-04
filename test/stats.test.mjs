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