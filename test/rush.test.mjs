import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rushConfigs, generateRushFromConfig, loadDataset } from '../tasks/rush/load.mjs';
import { RushWorld } from '../tasks/rush/world.mjs';
import { solve, greedy, isGoal, applyMove } from '../tasks/rush/rush.mjs';

test('dataset is solver-calibrated: every task solvable, greedy fails', () => {
  const ds = loadDataset();
  assert.ok(ds.tasks.length >= 100, `need a real dataset, got ${ds.tasks.length}`);
  assert.equal(ds.stats.allDefeatGreedy, true);
  for (const t of ds.tasks.slice(0, 20)) {
    const sol = solve(t.board, { maxStates: 300_000 });
    assert.ok(sol, `seed ${t.seed} must be solvable`);
    assert.equal(sol.depth, t.meta.optimalDepth, `seed ${t.seed} depth must match`);
    assert.equal(greedy(t.board).solved, false, `seed ${t.seed} greedy must fail`);
  }
});

test('oracle reaches goal_met for every obligation variant', () => {
  const cfgs = rushConfigs({ obligations: ['off', 'decay', 'deadline'], limit: 12 });
  for (const cfg of cfgs) {
    const { task, oracle } = generateRushFromConfig(cfg);
    const w = RushWorld.create(task, { seed: cfg.seed });
    for (const a of oracle) { if (w.done) break; w.step(a); }
    assert.equal(w.profile().terminal?.reason, 'goal_met', task.id);
    assert.equal(w.profile().solved, true, `${task.id}: board must actually be solved`);
  }
});

test('EXPLOIT BLOCKED: generic set cannot fake a win by writing pos.X.col', () => {
  const cfg = rushConfigs({ obligations: ['off'], limit: 1 })[0];
  const { task } = generateRushFromConfig(cfg);
  const w = RushWorld.create(task, { seed: 1 });
  const before = JSON.stringify(w.state.pos.X);
  const r = w.step({ type: 'set', args: { path: 'pos.X.col', value: 4 } });
  assert.equal(r.ok, false, 'set must be rejected in rush');
  assert.equal(JSON.stringify(w.state.pos.X), before, 'state must be unchanged');
  assert.notEqual(w.terminal?.reason, 'goal_met', 'must not fake a win');
  assert.equal(w.profile().solved, false);
});

test('EXPLOIT BLOCKED: inc/push/remove also rejected', () => {
  const cfg = rushConfigs({ obligations: ['off'], limit: 1 })[0];
  const { task } = generateRushFromConfig(cfg);
  const w = RushWorld.create(task, { seed: 1 });
  for (const type of ['inc', 'push', 'remove']) {
    const r = w.step({ type, args: { path: 'pos.X.col', by: 4, value: 4 } });
    assert.equal(r.ok, false, `${type} must be rejected`);
  }
  assert.notEqual(w.terminal?.reason, 'goal_met');
});

test('action surface exposes only move/noop/tend, not generic mutators', () => {
  const cfg = rushConfigs({ obligations: ['off'], limit: 1 })[0];
  const { task } = generateRushFromConfig(cfg);
  const w = RushWorld.create(task, { seed: 1 });
  const names = w.observe().actions.map((a) => a.name);
  assert.ok(names.includes('move'));
  for (const forbidden of ['set', 'inc', 'push', 'remove']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be offered`);
  }
});

test('a real solution moves X to the exit and wins', () => {
  const cfg = rushConfigs({ obligations: ['off'], limit: 1 })[0];
  const { task, oracle } = generateRushFromConfig(cfg);
  const w = RushWorld.create(task, { seed: cfg.seed });
  for (const a of oracle) { if (w.done) break; w.step(a); }
  assert.equal(w.terminal?.reason, 'goal_met');
  const x = w.board.find((v) => v.id === 'X');
  assert.equal(x.col + x.len, 6, 'X right end must reach the exit column');
  assert.equal(isGoal(w.board), true);
});

test('illegal moves are logged and never change the board', () => {
  const cfg = rushConfigs({ obligations: ['off'], limit: 1 })[0];
  const { task } = generateRushFromConfig(cfg);
  const w = RushWorld.create(task, { seed: 1 });
  const before = JSON.stringify(w.board);
  // X is blocked; a large positive delta is illegal.
  w.step({ type: 'move', args: { id: 'X', delta: 4 } });
  assert.equal(JSON.stringify(w.board), before, 'illegal move must not change board');
  assert.ok(w.profile().illegalMoves >= 1);
});

test('board observation includes grid, vehicles and legal moves but no solution', () => {
  const cfg = rushConfigs({ obligations: ['off'], limit: 1 })[0];
  const { task } = generateRushFromConfig(cfg);
  const w = RushWorld.create(task, { seed: 1 });
  const obs = w.observe();
  assert.ok(obs.board.grid.length === 6);
  assert.ok(obs.board.vehicles.length >= 2);
  assert.ok(obs.board.legalMoves.X !== undefined);
  const blob = JSON.stringify(obs);
  assert.ok(!blob.includes('solution'), 'must not leak the solution');
  assert.ok(!blob.includes('VIGIL_RUSH_SOL'), 'must not leak the canary');
});

test('determinism: same seed and moves give identical board and records', () => {
  const cfg = rushConfigs({ obligations: ['off'], limit: 1 })[0];
  const { task, oracle } = generateRushFromConfig(cfg);
  const run = () => {
    const w = RushWorld.create(task, { seed: cfg.seed });
    for (const a of oracle) { if (w.done) break; w.step(a); }
    return JSON.stringify({ board: w.board, records: w.records, profile: w.profile() });
  };
  assert.equal(run(), run());
});