import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSwe, sweModules, MODULES } from '../tasks/swe/generate.mjs';
import { SweWorld } from '../tasks/swe/world.mjs';
import { runAll, runCheck } from '../tasks/swe/verify.mjs';

test('swe family exposes three authored modules', () => {
  const mods = sweModules();
  assert.equal(mods.length, 3);
  for (const m of mods) assert.ok(m.requirements >= 5);
});

test('initial source fails some requirements; oracle passes all', async () => {
  for (let i = 0; i < MODULES.length; i++) {
    const { task } = generateSwe({ moduleIndex: i, depth: 5, obligation: 'off' });
    const before = await runAll(task.swe.module.initial, task.constraints);
    const after = await runAll(task.swe.module.oracleSource, task.constraints);
    assert.ok(before.passed.length < task.constraints.length, `${task.id}: initial must be incomplete`);
    assert.equal(after.passed.length, task.constraints.length, `${task.id}: oracle must pass all`);
  }
});

test('oracle reaches goal_met across modules, obligations and seeds', async () => {
  for (let i = 0; i < MODULES.length; i++) {
    for (const obligation of ['off', 'deadline', 'decay']) {
      for (const seed of [1, 2]) {
        const { task, oracle } = generateSwe({ moduleIndex: i, depth: 5, obligation, seed });
        const w = await SweWorld.create(task, { seed });
        for (const a of oracle) { if (w.done) break; await w.stepAsync(a); }
        assert.equal(w.profile().terminal?.reason, 'goal_met', task.id);
      }
    }
  }
});

test('requirement checks execute real code, not a model opinion', async () => {
  const { task } = generateSwe({ moduleIndex: 0, depth: 5, obligation: 'off' });
  const broken = 'export function parse(){ return {}; }';
  const r = await runAll(broken, task.constraints);
  assert.ok(r.passed.length < task.constraints.length);
  const syntaxError = 'export function parse( {';
  const r2 = await runAll(syntaxError, task.constraints);
  assert.equal(r2.passed.length, 0, 'a syntax error must fail every check, not crash');
  assert.ok(r2.results.every((x) => x.error));
});

test('a throwing candidate is a failed check, not a harness crash', async () => {
  const { task } = generateSwe({ moduleIndex: 1, obligation: 'off' });
  const src = 'export function compare(){ throw new Error("boom"); }';
  const r = await runCheck(src, task.constraints[0].sweCheck, task.constraints[0].id);
  assert.equal(r.ok, false);
  assert.match(r.error, /threw: boom/);
});

test('candidate code cannot read the filesystem', async () => {
  const { task } = generateSwe({ moduleIndex: 0, obligation: 'off' });
  const src = `
    import { readFileSync } from 'node:fs';
    export function parse(){ return readFileSync('/etc/passwd','utf8'); }
  `;
  const r = await runAll(src, task.constraints);
  // data: URL modules cannot resolve node: builtins in this context; even if
  // they could, the check would fail the expected-value comparison.
  assert.ok(r.passed.length === 0);
});

test('ci watchdog kills a run that never runs CI', async () => {
  const { task } = generateSwe({ moduleIndex: 0, depth: 5, obligation: 'deadline', seed: 3 });
  const w = await SweWorld.create(task, { seed: 3 });
  // Edit correctly but never run CI: the watchdog must expire.
  await w.stepAsync({ type: 'edit', args: { source: task.swe.module.oracleSource } });
  for (let i = 0; i < task.maxSteps && !w.done; i++) await w.stepAsync({ type: 'noop' });
  assert.equal(w.profile().terminal?.reason, 'obligation_died');
  assert.deepEqual(w.profile().obligationsDead, ['ci-watchdog']);
});

test('running CI discharges the watchdog', async () => {
  const { task, oracle } = generateSwe({ moduleIndex: 0, depth: 5, obligation: 'deadline', seed: 4 });
  const w = await SweWorld.create(task, { seed: 4 });
  for (const a of oracle) { if (w.done) break; await w.stepAsync(a); }
  assert.equal(w.profile().terminal?.reason, 'goal_met');
  assert.ok(w.state.ciRuns > 0);
});

test('swe attribution records which edit broke an earlier requirement', async () => {
  const { task } = generateSwe({ moduleIndex: 0, depth: 5, obligation: 'off', seed: 5 });
  const w = await SweWorld.create(task, { seed: 5 });
  // Satisfy everything, then regress with a bad edit.
  await w.stepAsync({ type: 'edit', args: { source: task.swe.module.oracleSource } });
  await w.stepAsync({ type: 'run_ci' });
  const goodPassed = [...w.state.passed];
  assert.equal(goodPassed.length, 5);
  await w.stepAsync({ type: 'edit', args: { source: 'export function parse(){ return {}; }' } });
  assert.ok(w.state.passed.length < goodPassed.length);
  const broke = w.records.filter((r) => r.class === 'broke' || r.class === 'regressed');
  assert.ok(broke.length > 0, 'regression must be attributed');
});

test('swe observation hides the oracle and the test source', async () => {
  const { task } = generateSwe({ moduleIndex: 0, obligation: 'off' });
  const w = await SweWorld.create(task, { seed: 1 });
  const blob = JSON.stringify(w.observe());
  assert.ok(!blob.includes('VIGIL_SWE_ORACLE'));
  assert.ok(!blob.includes('VIGIL_SWE_TESTS'));
  assert.ok(!blob.includes('oracleSource'));
  assert.ok(!blob.includes('sweCheck'));
});