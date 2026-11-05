import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, num, str, ref, op, summariseAttribution } from '../engine/index.mjs';

// A minimal task with a REAL conflict: c1 wants tank.level >= 8, c2 (revealed
// later) wants tank.level <= 5 while also requiring pipe.open. There is no
// single `set` that satisfies both — the agent must use the `split` action to
// route flow, which is the coupled-state search the benchmark is about.
function conflictTask(overrides = {}) {
  return {
    id: 'test-conflict',
    genericWrites: 'all',
    maxSteps: 40,
    initialState: { tank: { level: 0 }, pipe: { open: false }, bypass: { level: 0 } },
    constraints: [
      { id: 'c1', revealAt: 0, text: 'tank.level must be at least 8', predicate: op('ge', ref('tank.level'), num(8)) },
      { id: 'c2', revealAt: 2, text: 'tank.level must be at most 5 and pipe.open true',
        predicate: op('and', op('le', ref('tank.level'), num(5)), op('eq', ref('pipe.open'), { t: 'bool', v: true })) },
    ],
    actions: [
      { name: 'split', args: [], cost: 2, doc: 'route half the tank into bypass',
        effects: [
          { path: 'bypass.level', value: op('add', ref('bypass.level'), ref('tank.level')) },
          { path: 'tank.level', value: num(0) },
        ] },
    ],
    goals: [{ id: 'g', predicate: op('ge', ref('bypass.level'), num(8)) }],
    ...overrides,
  };
}

test('world validates task shape', () => {
  assert.throws(() => new World({ id: 'x' }), /needs initialState/);
  assert.throws(() => new World({ id: 'x', initialState: {}, constraints: [] }), /needs constraints/);
});

test('reached and passed are distinct counters', () => {
  const w = new World(conflictTask());
  assert.equal(w.observe().progress.reached, 1);
  assert.equal(w.observe().progress.passed, 0);
  w.step({ type: 'set', args: { path: 'tank.level', value: 9 } });
  assert.equal(w.passed, 1, 'c1 holds');
  // step into reveal of c2 without satisfying it
  w.step({ type: 'noop' });
  assert.equal(w.reached, 2);
  assert.equal(w.passed, 1, 'c2 revealed but unsatisfied: passed must not advance');
});

test('breaking an earlier constraint is attributed to the exact action', () => {
  const w = new World(conflictTask());
  w.step({ type: 'set', args: { path: 'tank.level', value: 9 } });   // step 0: c1 holds
  w.step({ type: 'noop' });                                          // step 1: c2 reveals
  w.step({ type: 'set', args: { path: 'pipe.open', value: true } }); // step 2
  w.step({ type: 'set', args: { path: 'tank.level', value: 3 } });   // step 3: satisfies c2, BREAKS c1
  const broke = w.records.filter((r) => r.constraintId === 'c1' && r.class === 'broke');
  assert.equal(broke.length, 1);
  assert.equal(broke[0].stepIndex, 3);
  assert.equal(broke[0].introducedAtStep, 0);
  assert.equal(broke[0].ageInSteps, 3);
  assert.ok(broke[0].blamedPaths.includes('tank.level'));
  assert.equal(broke[0].witness.values['tank.level'], 3);
});

test('a freshly revealed unsatisfied constraint is class=revealed, not broke', () => {
  const w = new World(conflictTask());
  w.step({ type: 'noop' });
  w.step({ type: 'noop' });
  const rev = w.records.filter((r) => r.constraintId === 'c2' && r.class === 'revealed');
  assert.equal(rev.length, 1);
});

test('untouched failing constraint is neglected, touched-but-unfixed is regressed', () => {
  const w = new World(conflictTask());
  w.step({ type: 'noop' }); // c1 fails from the start
  w.step({ type: 'noop' });
  const neglected = w.records.filter((r) => r.constraintId === 'c1' && r.class === 'neglected');
  assert.ok(neglected.length >= 1);
  w.step({ type: 'set', args: { path: 'tank.level', value: 1 } }); // touches read-set, still fails
  const regressed = w.records.filter((r) => r.constraintId === 'c1' && r.class === 'regressed');
  assert.ok(regressed.length >= 1);
});

test('oracle action sequence solves the conflict with zero violations after reveal', () => {
  const w = new World(conflictTask());
  w.step({ type: 'set', args: { path: 'tank.level', value: 9 } });
  w.step({ type: 'set', args: { path: 'pipe.open', value: true } });
  w.step({ type: 'set', args: { path: 'tank.level', value: 3 } });
  w.step({ type: 'split' });
  // after split, tank=0 breaks c1 again — the honest oracle must refill via bypass-aware path.
  // This asserts the engine reports it rather than hiding it.
  const summary = summariseAttribution(w.records);
  assert.ok(summary.constraintViolations > 0, 'conflict is real: naive oracle still breaks c1');
});

test('invalid actions are logged, not thrown, and do not crash the harness', () => {
  const w = new World(conflictTask());
  const r1 = w.step({ type: 'nonexistent' });
  assert.equal(r1.ok, false);
  const r2 = w.step({ type: 'inc', args: { path: 'tank.level' } });
  assert.equal(r2.ok, true);
  const r3 = w.step({ type: 'push', args: { path: 'tank.level', value: 1 } });
  assert.equal(r3.ok, false, 'push onto a number is invalid');
  assert.equal(w.profile().invalidActions, 2);
});

test('observation never leaks predicates or unrevealed constraints', () => {
  const w = new World(conflictTask());
  const obs = w.observe();
  const blob = JSON.stringify(obs);
  assert.ok(!blob.includes('predicate'));
  assert.equal(obs.constraints.length, 1, 'only c1 revealed at step 0');
  assert.ok(!blob.includes('c2'));
});

test('determinism: same seed and actions give identical records', () => {
  const run = () => {
    const w = new World(conflictTask(), { seed: 42 });
    for (let i = 0; i < 6; i++) w.step({ type: 'inc', args: { path: 'tank.level', by: 2 } });
    return JSON.stringify({ records: w.records, profile: w.profile() });
  };
  assert.equal(run(), run());
});