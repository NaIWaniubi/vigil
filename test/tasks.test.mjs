import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, grid, taskFingerprint, KNOBS } from '../tasks/core/generate.mjs';
import { World } from '../engine/index.mjs';

function runOracle(cfg) {
  const { task, oracle } = generate(cfg);
  const w = new World(task, { seed: cfg.seed });
  for (const a of oracle) { if (w.done) break; w.step(a); }
  return { task, oracle, world: w, profile: w.profile() };
}

test('generator rejects out-of-range knobs', () => {
  assert.throws(() => generate({ conflict: 'bogus' }), /bad conflict knob/);
  assert.throws(() => generate({ obligation: 'bogus' }), /bad obligation knob/);
  assert.throws(() => generate({ depth: 1 }), /depth out of range/);
  assert.throws(() => generate({ depth: 99 }), /depth out of range/);
});

test('generation is deterministic for a fixed config', () => {
  const a = generate({ seed: 7, depth: 12, conflict: 'coupled', obligation: 'decay' });
  const b = generate({ seed: 7, depth: 12, conflict: 'coupled', obligation: 'decay' });
  assert.equal(taskFingerprint(a.task), taskFingerprint(b.task));
  assert.deepEqual(a.oracle, b.oracle);
});

test('different seeds give different tasks', () => {
  const a = generate({ seed: 1, depth: 12 });
  const b = generate({ seed: 2, depth: 12 });
  assert.notEqual(taskFingerprint(a.task), taskFingerprint(b.task));
});

test('every gadget owns a distinct slot, even at depth 48', () => {
  const { task } = generate({ seed: 3, depth: 48, conflict: 'coupled', obligation: 'off' });
  const slots = Object.keys(task.initialState).filter((k) => k !== 'store');
  assert.equal(slots.length, 24, 'depth 48 = 24 gadgets');
  assert.equal(new Set(slots).size, slots.length, 'no slot reuse');
});

test('coupled tasks are jointly satisfiable, not contradictory', () => {
  const { task, world, profile } = runOracle({ seed: 4, depth: 12, conflict: 'coupled', obligation: 'off' });
  assert.equal(profile.terminal.reason, 'goal_met');
  assert.equal(profile.passed, task.constraints.length, 'ALL constraints hold at the end');
  for (const g of Object.keys(task.initialState).filter((k) => k !== 'store')) {
    assert.ok(world.state[g].level > 0, `${g} refilled into its band`);
  }
});

test('coupled mode creates repair pressure a greedy policy falls into', async () => {
  const { greedy } = await import('../tasks/core/policies.mjs');
  const pressure = (conflict) => {
    const { task } = generate({ seed: 9, depth: 18, conflict, obligation: 'off' });
    const w = greedy(task, { seed: 9 });
    // `regressed` = a rule was already failing, the agent touched its read-set,
    // and still did not fix it. Only coupled gadgets produce this under greedy.
    return w.records.filter((r) => r.class === 'regressed' || r.class === 'broke').length;
  };
  const coupled = pressure('coupled');
  const plain = pressure('none');
  assert.ok(coupled > plain, `coupled=${coupled} should exceed independent=${plain}`);
  assert.equal(plain, 0, 'independent constraints must not punish a greedy policy');
});

test('coupled gadgets expose a repair action the greedy policy does not use', () => {
  const { task } = generate({ seed: 9, depth: 6, conflict: 'coupled', obligation: 'off' });
  const names = task.actions.map((a) => a.name);
  assert.ok(names.some((n) => n.startsWith('vent_')), 'vent is the escape hatch');
  assert.ok(names.some((n) => n.startsWith('fill_')), 'fill is the coupling');
  const { task: plain } = generate({ seed: 9, depth: 6, conflict: 'none', obligation: 'off' });
  assert.ok(!plain.actions.some((a) => a.name.startsWith('vent_')), 'independent mode needs no repair');
});

test('the full ablation grid is admitted by the oracle', () => {
  for (const cfg of grid({ seeds: [11, 12], depths: [6, 12, 18] })) {
    const { profile } = runOracle(cfg);
    assert.equal(profile.terminal?.reason, 'goal_met', `${cfg.conflict}/${cfg.obligation}/d${cfg.depth}/s${cfg.seed}`);
  }
});

test('obligation budgets make neglect fatal for every kind', () => {
  for (const obligation of ['decay', 'deadline', 'hazard']) {
    const cfg = { seed: 13, depth: 12, conflict: 'coupled', obligation };
    const { task, oracle } = generate(cfg);
    const w = new World(task, { seed: cfg.seed });
    for (const a of oracle.filter((x) => x.type !== 'tend')) { if (w.done) break; w.step(a); }
    assert.notEqual(w.profile().terminal?.reason, 'goal_met', `${obligation}: neglect must not win`);
    assert.ok(w.profile().obligationsDead.length > 0, `${obligation}: neglect must kill`);
  }
});

test('off mode has no obligations and survives without tending', () => {
  const { task, oracle, profile } = runOracle({ seed: 14, depth: 12, obligation: 'off' });
  assert.equal(task.obligations.length, 0);
  assert.ok(!oracle.some((a) => a.type === 'tend'));
  assert.equal(profile.terminal.reason, 'goal_met');
});

test('grid enumerates the full cross product', () => {
  const g = grid({ seeds: [1, 2], depths: [6, 12] });
  assert.equal(g.length, 2 * 2 * KNOBS.conflict.length * KNOBS.obligation.length);
});

test('task text never leaks the predicate or the answer', () => {
  const { task } = generate({ seed: 15, depth: 6 });
  const w = new World(task, { seed: 15 });
  const blob = JSON.stringify(w.observe());
  assert.ok(!blob.includes('predicate'));
  assert.ok(!blob.includes('VIGIL_KEY'));
  assert.ok(!blob.includes('goalTotal'));
});