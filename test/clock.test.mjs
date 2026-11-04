import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, num, ref, op } from '../engine/index.mjs';

// The Paul mechanism. A decay obligation runs on ENVIRONMENT ticks, and ticks
// accrue with action cost. An agent that takes expensive foreground actions
// pays more neglect. This is the H2 apparatus: main-line progress and
// background maintenance are driven by the same budget but scored separately.
function paulTask(overrides = {}) {
  return {
    id: 'test-paul',
    maxSteps: 60,
    initialState: { work: { done: 0 } },
    constraints: [
      { id: 'c1', revealAt: 0, text: 'work.done must reach 10', predicate: op('ge', ref('work.done'), num(10)) },
    ],
    obligations: [
      { id: 'paul', kind: 'decay', revealAt: 0, initial: 10, rate: 1, repairAction: 'tend', repairAmount: 10 },
    ],
    goals: [{ id: 'g', predicate: op('ge', ref('work.done'), num(10)) }],
    actions: [
      { name: 'slowWork', args: [], cost: 5, doc: 'expensive foreground action',
        effects: [{ path: 'work.done', value: op('add', ref('work.done'), num(5)) }] },
      { name: 'fastWork', args: [], cost: 1, doc: 'cheap foreground action',
        effects: [{ path: 'work.done', value: op('add', ref('work.done'), num(1)) }] },
    ],
    ...overrides,
  };
}

test('neglect kills the obligation even while the main line advances', () => {
  const w = new World(paulTask());
  // Two slowWork actions = 10 ticks = paul exhausted, though work.done = 10.
  w.step({ type: 'slowWork' });
  assert.equal(w.done, false);
  w.step({ type: 'slowWork' });
  assert.equal(w.done, true);
  assert.equal(w.terminal.reason, 'obligation_died');
  assert.equal(w.terminal.obligationId, 'paul');
  const p = w.profile();
  assert.equal(p.passed, 1, 'main-line constraint WAS satisfied');
  assert.deepEqual(p.obligationsDead, ['paul']);
  const death = w.records.find((r) => r.obligationId === 'paul');
  assert.equal(death.class, 'obligation_lapsed');
  assert.equal(death.repairs, 0);
});

test('tending keeps it alive and the run can reach the goal', () => {
  const w = new World(paulTask());
  for (let i = 0; i < 10; i++) {
    w.step({ type: 'fastWork' });
    if (w.done) break;
    if (i % 5 === 4) w.step({ type: 'tend', args: { obligationId: 'paul' } });
  }
  assert.equal(w.terminal?.reason, 'goal_met');
  assert.deepEqual(w.profile().obligationsDead, []);
});

test('tick cost is decoupled from turn count', () => {
  const slow = new World(paulTask());
  const fast = new World(paulTask());
  slow.step({ type: 'slowWork' });
  for (let i = 0; i < 5; i++) fast.step({ type: 'fastWork' });
  assert.equal(slow.stepIndex, 1);
  assert.equal(fast.stepIndex, 5);
  assert.equal(slow.tick, fast.tick, 'same environment time, different turn counts');
  assert.equal(slow.live.get('paul').level, fast.live.get('paul').level);
});

test('deadline obligation fires on environment time', () => {
  const w = new World(paulTask({
    obligations: [{ id: 'ci', kind: 'deadline', revealAt: 0, dueAt: 6, repairAction: 'tend', extendBy: 10 }],
  }));
  w.step({ type: 'slowWork' }); // tick 5
  assert.equal(w.done, false);
  w.step({ type: 'fastWork' }); // tick 6 -> overdue
  assert.equal(w.terminal?.reason, 'obligation_died');
  assert.equal(w.records.find((r) => r.obligationId === 'ci').cause, 'overdue');
});

test('tending a deadline marks it done and prevents death', () => {
  const w = new World(paulTask({
    obligations: [{ id: 'ci', kind: 'deadline', revealAt: 0, dueAt: 6, repairAction: 'tend', extendBy: 10 }],
    // c1 would end the run at work.done=10 before the deadline matters;
    // raise it so this test isolates the deadline mechanism.
    constraints: [{ id: 'c1', revealAt: 0, text: 'work.done must reach 100', predicate: op('ge', ref('work.done'), num(100)) }],
    goals: [{ id: 'g', predicate: op('ge', ref('work.done'), num(100)) }],
  }));
  w.step({ type: 'slowWork' });                                  // tick 5
  w.step({ type: 'tend', args: { obligationId: 'ci' } });        // discharged
  w.step({ type: 'slowWork' });                                  // tick 11 > original dueAt 6
  w.step({ type: 'slowWork' });                                  // tick 16
  assert.equal(w.done, false, 'discharged deadline must not fire');
  assert.equal(w.profile().obligationsDead.length, 0);
});

test('an untended deadline still fires past its original due time', () => {
  const w = new World(paulTask({
    obligations: [{ id: 'ci', kind: 'deadline', revealAt: 0, dueAt: 6, repairAction: 'tend', extendBy: 10 }],
    constraints: [{ id: 'c1', revealAt: 0, text: 'work.done must reach 100', predicate: op('ge', ref('work.done'), num(100)) }],
    goals: [{ id: 'g', predicate: op('ge', ref('work.done'), num(100)) }],
  }));
  w.step({ type: 'slowWork' });
  w.step({ type: 'fastWork' });
  assert.equal(w.terminal?.reason, 'obligation_died');
});

test('hazard ignition is deterministic and independent of seed', () => {
  // Heat accumulates per exposed tick, so the seed no longer changes the
  // outcome. That is deliberate: a lucky run must not survive neglect.
  const spec = paulTask({
    obligations: [{ id: 'fire', kind: 'hazard', revealAt: 0, probPerTick: 0.25, repairAction: 'tend', shieldTicks: 2 }],
    obligationDeathEndsRun: false,
    maxSteps: 200,
    // Raise the main-line bar so the run does not end on goal_met before the
    // hazard has time to ignite; this isolates the hazard mechanism.
    constraints: [{ id: 'c1', revealAt: 0, text: 'work.done >= 100', predicate: op('ge', ref('work.done'), num(100)) }],
    goals: [{ id: 'g', predicate: op('ge', ref('work.done'), num(100)) }],
  });
  const run = (seed) => {
    const w = new World(spec, { seed });
    for (let i = 0; i < 20 && !w.done; i++) w.step({ type: 'fastWork' });
    const death = w.records.find((r) => r.obligationId === 'fire');
    return { ignitedAtTick: death?.tick, dead: w.profile().obligationsDead };
  };
  assert.deepEqual(run(7), run(7), 'same seed replays exactly');
  assert.deepEqual(run(7), run(99), 'cumulative heat is seed-independent by design');
  // spawn shield absorbs ticks 1-2, then 4 exposed ticks reach risk 1.0
  assert.equal(run(7).ignitedAtTick, 6);
  assert.deepEqual(run(7).dead, ['fire']);
});

test('hazard risk is visible to the agent so neglect is a choice, not a surprise', () => {
  const w = new World(paulTask({
    obligations: [{ id: 'fire', kind: 'hazard', revealAt: 0, probPerTick: 0.25, repairAction: 'tend', shieldTicks: 2 }],
    obligationDeathEndsRun: false,
  }));
  w.step({ type: 'fastWork' });
  w.step({ type: 'fastWork' });
  w.step({ type: 'fastWork' });
  const ob = w.observe().obligations.find((o) => o.id === 'fire');
  assert.equal(ob.risk, 0.25);
  assert.equal(ob.shieldTicks, 0);
});

test('tending grants a shield measured in ticks, and neglect exhausts it', () => {
  const w = new World(paulTask({
    obligations: [{ id: 'fire', kind: 'hazard', revealAt: 0, probPerTick: 1, repairAction: 'tend', shieldTicks: 3 }],
    obligationDeathEndsRun: false,
    maxSteps: 100,
  }));
  w.step({ type: 'tend', args: { obligationId: 'fire' } });
  assert.equal(w.done, false, 'certain hazard must not fire on the tending step');
  assert.equal(w.live.get('fire').shield, 3);
  w.step({ type: 'fastWork' }); // shield 3 -> 2
  w.step({ type: 'fastWork' }); // 2 -> 1
  assert.equal(w.profile().obligationsDead.length, 0, 'still shielded');
  w.step({ type: 'fastWork' }); // 1 -> 0
  w.step({ type: 'fastWork' }); // unshielded, p=1 -> dies
  assert.deepEqual(w.profile().obligationsDead, ['fire']);
});

test('a freshly revealed hazard cannot kill before the agent can react', () => {
  const w = new World(paulTask({
    obligations: [{ id: 'fire', kind: 'hazard', revealAt: 2, probPerTick: 1, repairAction: 'tend', shieldTicks: 4 }],
    obligationDeathEndsRun: false,
  }));
  w.step({ type: 'fastWork' });
  w.step({ type: 'fastWork' }); // hazard reveals here
  assert.equal(w.profile().obligationsDead.length, 0, 'spawn shield must protect the reveal tick');
  assert.ok(w.live.get('fire').shield > 0);
});

test('obligation death can be configured non-terminal for ablation', () => {
  const w = new World(paulTask({ obligationDeathEndsRun: false }));
  w.step({ type: 'slowWork' });
  w.step({ type: 'slowWork' });
  assert.equal(w.done, false, 'ablation mode keeps running after neglect death');
  assert.deepEqual(w.profile().obligationsDead, ['paul']);
  w.step({ type: 'tend', args: { obligationId: 'paul' } });
  assert.equal(w.actionLog.at(-1).ok, false, 'cannot revive the dead');
});

test('observation exposes obligation urgency but not its spec', () => {
  const w = new World(paulTask());
  w.step({ type: 'slowWork' });
  const ob = w.observe().obligations.find((o) => o.id === 'paul');
  assert.equal(ob.level, 5);
  assert.ok(!JSON.stringify(w.observe()).includes('rate'));
  assert.ok(!JSON.stringify(w.observe()).includes('repairAmount'));
});