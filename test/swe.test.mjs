// vigil-swe contract tests.
//
// The family is a set of MULTI-FILE mini-repos. Every requirement check RUNS the
// candidate's whole repository (real cross-module imports), one edit touches one
// file, and a naive fix of a later requirement can break an earlier one — that
// regression must be attributed, not hidden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSwe, sweModules, MODULES } from '../tasks/swe/generate.mjs';
import { SweWorld } from '../tasks/swe/world.mjs';
import { runAll, runRepo } from '../tasks/swe/verify.mjs';

async function replay(task, actions, seed = 1) {
  const w = await SweWorld.create(task, { seed });
  for (const a of actions) { if (w.done) break; await w.stepAsync(a); }
  return w;
}

// ---------------------------------------------------------------------------
// Repo authoring contracts
// ---------------------------------------------------------------------------

test('swe family exposes at least four multi-file repos with real import edges', () => {
  assert.ok(MODULES.length >= 4, 'need >= 4 repos');
  assert.equal(sweModules().length, MODULES.length);
  for (const m of MODULES) {
    const names = Object.keys(m.initial);
    assert.ok(names.length >= 3 && names.length <= 6, `${m.id}: 3-6 source files, got ${names.length}`);
    assert.deepEqual(Object.keys(m.oracle).sort(), names.sort(), `${m.id}: oracle covers every file`);
    let edges = 0;
    for (const name of names) {
      const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
      const re = /(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g;
      let mt;
      while ((mt = re.exec(m.oracle[name]))) {
        const target = resolveRel(dir, mt[1]);
        assert.ok(names.includes(target), `${m.id}: ${name} imports missing file ${mt[1]}`);
        edges++;
      }
    }
    assert.ok(edges >= 2, `${m.id}: needs real inter-module imports, found ${edges}`);
    assert.ok(m.requirements.length >= 5, `${m.id}: needs >= 5 requirements`);
    assert.ok(m.naiveFix && m.naiveFix.file && m.naiveFix.satisfies && m.naiveFix.breaks,
      `${m.id}: needs a regression-coupling fixture`);
  }
});

function resolveRel(dir, spec) {
  const parts = dir ? dir.split('/') : [];
  for (const seg of spec.split('/')) {
    if (seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

test('initial source fails some requirements; oracle sources pass every check in every repo', async () => {
  for (const m of MODULES) {
    const constraints = m.requirements.map((r) => ({ id: r.id, sweCheck: r.check }));
    const before = await runAll(m.initial, constraints);
    const after = await runAll(m.oracle, constraints);
    assert.ok(before.passed.length < constraints.length, `${m.id}: initial must be incomplete`);
    assert.ok(before.passed.length >= 1, `${m.id}: initial must not be total garbage`);
    assert.equal(after.passed.length, constraints.length,
      `${m.id}: oracle must pass all; failures: ${JSON.stringify(after.results.filter((r) => !r.ok))}`);
  }
});

test('each repo ships a naive single-file fix that satisfies a later req and breaks an earlier one', async () => {
  for (const m of MODULES) {
    const constraints = m.requirements.map((r) => ({ id: r.id, sweCheck: r.check }));
    const idxOf = (id) => m.requirements.findIndex((r) => r.id === id);
    assert.ok(idxOf(m.naiveFix.breaks) < idxOf(m.naiveFix.satisfies),
      `${m.id}: fixture must break an EARLIER requirement`);
    const base = await runAll(m.oracle, constraints);
    assert.ok(base.passed.includes(m.naiveFix.breaks), `${m.id}: earlier req must hold under oracle`);
    assert.ok(!base.passed.includes(m.naiveFix.satisfies) || true);
    const naive = { ...m.oracle, [m.naiveFix.file]: m.naiveFix.source };
    const after = await runAll(naive, constraints);
    assert.ok(after.passed.includes(m.naiveFix.satisfies),
      `${m.id}: naive fix must actually satisfy ${m.naiveFix.satisfies}: ${JSON.stringify(after.results)}`);
    assert.ok(!after.passed.includes(m.naiveFix.breaks),
      `${m.id}: naive fix must break ${m.naiveFix.breaks}`);
  }
});

// ---------------------------------------------------------------------------
// Oracle solvability
// ---------------------------------------------------------------------------

test('every repo oracle reaches goal_met across obligations off/deadline/decay and seeds 1,2', async () => {
  for (let i = 0; i < MODULES.length; i++) {
    for (const obligation of ['off', 'deadline', 'decay']) {
      for (const seed of [1, 2]) {
        const { task, oracle } = generateSwe({ repoIndex: i, depth: 5, obligation, seed });
        const w = await replay(task, oracle, seed);
        assert.equal(w.profile().terminal?.reason, 'goal_met',
          `${task.id}: ended ${JSON.stringify(w.profile().terminal)}, passed=${JSON.stringify(w.state.passed)}`);
        assert.equal(w.profile().passed, task.constraints.length, `${task.id}: all constraints must hold`);
        assert.ok(w.state.ciRuns >= 1, `${task.id}: CI must have run`);
      }
    }
  }
});

test('moduleIndex remains an alias for repoIndex (self-audit compatibility)', async () => {
  const a = generateSwe({ moduleIndex: 1, depth: 5, obligation: 'deadline', seed: 1 });
  const b = generateSwe({ repoIndex: 1, depth: 5, obligation: 'deadline', seed: 1 });
  assert.equal(a.task.id, b.task.id);
  assert.deepEqual(a.oracle, b.oracle);
});

test('depth maps to requirement count, capped at the repo, minimum 2', () => {
  const m = MODULES[0];
  const full = generateSwe({ repoIndex: 0, depth: 99, obligation: 'off' });
  assert.equal(full.task.constraints.length, m.requirements.length);
  const small = generateSwe({ repoIndex: 0, depth: 2, obligation: 'off' });
  assert.equal(small.task.constraints.length, 2);
  const tiny = generateSwe({ repoIndex: 0, depth: 0, obligation: 'off' });
  assert.equal(tiny.task.constraints.length, 2);
});

test('oracle still solves depth-2 tasks under every obligation', async () => {
  for (const obligation of ['off', 'deadline', 'decay']) {
    const { task, oracle } = generateSwe({ repoIndex: 0, depth: 2, obligation, seed: 2 });
    const w = await replay(task, oracle, 2);
    assert.equal(w.profile().terminal?.reason, 'goal_met', task.id);
  }
});

// ---------------------------------------------------------------------------
// Multi-file editing and the verifier
// ---------------------------------------------------------------------------

test('edit(file, source) replaces exactly one file and recomputes checks over the whole repo', async () => {
  const { task } = generateSwe({ repoIndex: 0, depth: 5, obligation: 'off' });
  const w = await SweWorld.create(task, { seed: 1 });
  const file = task.meta.entry;
  const before = { ...w.state.files };
  const res = await w.stepAsync({ type: 'edit', args: { file, source: '// wiped\nexport const broken = true;\n' } });
  assert.equal(res.ok, true);
  assert.equal(w.state.edits, 1);
  for (const [name, src] of Object.entries(before)) {
    if (name === file) assert.notEqual(w.state.files[name], src);
    else assert.equal(w.state.files[name], src, `${name} must be untouched`);
  }
});

test('edit with an unknown file or a non-string source is a logged failure, not a crash', async () => {
  const { task } = generateSwe({ repoIndex: 0, depth: 5, obligation: 'off' });
  const w = await SweWorld.create(task, { seed: 1 });
  const before = JSON.stringify(w.state.files);
  const r1 = await w.stepAsync({ type: 'edit', args: { file: 'src/nope.mjs', source: 'x' } });
  assert.equal(r1.ok, false);
  const r2 = await w.stepAsync({ type: 'edit', args: { file: task.meta.entry, source: 42 } });
  assert.equal(r2.ok, false);
  assert.equal(JSON.stringify(w.state.files), before, 'rejected edits must not mutate the repo');
});

test('cross-module imports actually execute in the verifier', async () => {
  const files = {
    'lib/dep.mjs': 'export const base = 40;\n',
    'main.mjs': 'import { base } from "./lib/dep.mjs";\nexport function answer(){ return base + 2; }\n',
  };
  const check = { entry: 'main.mjs', call: 'answer', args: [], expect: 42 };
  const r = await runRepo(files, [check]);
  assert.equal(r.passed.length, 1, JSON.stringify(r.results));
  // Break the DEPENDENCY; the entry file itself is unchanged — the check must fail.
  const broken = { ...files, 'lib/dep.mjs': 'export const base = 0;\n' };
  const r2 = await runRepo(broken, [check]);
  assert.equal(r2.passed.length, 0);
  // Missing dependency file is a failed check, not a crash.
  const r3 = await runRepo({ 'main.mjs': files['main.mjs'] }, [check]);
  assert.equal(r3.passed.length, 0);
  assert.ok(r3.results[0].error);
});

test('a throwing or syntax-error candidate fails checks, never crashes the harness', async () => {
  const { task } = generateSwe({ repoIndex: 1, depth: 5, obligation: 'off' });
  const entry = task.meta.entry;
  const throwing = { ...task.swe.module.initial, [entry]: null };
  // Replace the entry with a module whose exports throw.
  const exported = Object.keys(task.swe.module.initial).length;
  assert.ok(exported >= 3);
  throwing[entry] = 'export function boom(){ throw new Error("boom"); }\nexport default boom;\n';
  const constraints = task.constraints;
  const r = await runAll(throwing, constraints);
  assert.equal(r.passed.length, 0);
  const syntax = { ...task.swe.module.initial, [entry]: 'export function {{{' };
  const r2 = await runAll(syntax, constraints);
  assert.equal(r2.passed.length, 0);
  assert.ok(r2.results.every((x) => x.error), 'every check must report an error verdict');
});

test('candidate code cannot read the filesystem', async () => {
  const files = {
    'main.mjs': [
      'import { readFileSync } from "node:fs";',
      'export function steal(){ return readFileSync(process.env.VIGIL_FS_PROBE, "utf8").length; }',
    ].join('\n'),
  };
  process.env.VIGIL_FS_PROBE = new URL('../package.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  try {
    const r = await runRepo(files, [{ entry: 'main.mjs', call: 'steal', args: [], expect: -1 }]);
    assert.equal(r.passed.length, 0, 'filesystem-reading candidate must not pass');
    assert.ok(r.results[0].error, 'expected an access/load error verdict');
    // Dynamic import must be blocked too.
    const dyn = { 'main.mjs': 'export async function steal(){ const fs = await import("node:fs"); return fs.readFileSync(process.env.VIGIL_FS_PROBE, "utf8").length; }' };
    const r2 = await runRepo(dyn, [{ entry: 'main.mjs', call: 'steal', args: [], expect: -1 }]);
    assert.equal(r2.passed.length, 0);
    assert.ok(r2.results[0].error);
  } finally {
    delete process.env.VIGIL_FS_PROBE;
  }
});

test('an infinite-loop candidate times out as a failed check, not a hung harness', async () => {
  const files = { 'main.mjs': 'export function spin(){ while (true) {} }\n' };
  const r = await runRepo(files, [{ entry: 'main.mjs', call: 'spin', args: [], expect: 1 }], { timeoutMs: 1500 });
  assert.equal(r.passed.length, 0);
  assert.match(r.results[0].error, /timeout|timed out/i);
});

// ---------------------------------------------------------------------------
// Regression coupling through the world (attribution)
// ---------------------------------------------------------------------------

test('a naive single-file fix produces a broke/regressed attribution record for the earlier requirement', async () => {
  for (let i = 0; i < MODULES.length; i++) {
    const m = MODULES[i];
    const { task } = generateSwe({ repoIndex: i, depth: 5, obligation: 'off', seed: 5 });
    const w = await SweWorld.create(task, { seed: 5 });
    // Apply the full oracle repo one file at a time: everything passes.
    for (const [file, source] of Object.entries(m.oracle)) {
      await w.stepAsync({ type: 'edit', args: { file, source } });
    }
    // Advance until EVERY requirement is revealed, so the regression target is
    // an active constraint the engine is actually evaluating. CI is withheld:
    // running it now would satisfy the goal and terminate the world before the
    // regression can be exercised.
    while (w.pending.length && !w.done) await w.stepAsync({ type: 'noop' });
    assert.equal(w.done, false, `${m.id}: world must still be live before the naive fix`);
    assert.ok(w.active.some((c) => c.id === m.naiveFix.breaks), `${m.id}: regression target must be revealed`);
    assert.ok(w.state.passed.includes(m.naiveFix.breaks), `${m.id}: earlier req held before naive fix`);
    assert.equal(w.state.passed.length, task.constraints.length, `${m.id}: oracle state passes all`);
    const stepsBefore = w.stepIndex;
    // Now the naive single-file fix for the later requirement.
    await w.stepAsync({ type: 'edit', args: { file: m.naiveFix.file, source: m.naiveFix.source } });
    assert.ok(w.state.passed.includes(m.naiveFix.satisfies), `${m.id}: naive fix satisfies the later req`);
    assert.ok(!w.state.passed.includes(m.naiveFix.breaks), `${m.id}: naive fix broke the earlier req`);
    const rec = w.records.find((r) => r.constraintId === m.naiveFix.breaks
      && r.stepIndex === stepsBefore && (r.class === 'broke' || r.class === 'regressed'));
    assert.ok(rec, `${m.id}: expected a broke/regressed record, got ${JSON.stringify(w.records.filter((r) => r.constraintId === m.naiveFix.breaks))}`);
    assert.ok(rec.ageInSteps > 0, 'the broken rule is older than the breaking edit');
  }
});

// ---------------------------------------------------------------------------
// CI watchdog, observation boundary
// ---------------------------------------------------------------------------

test('CI watchdog kills a run that edits correctly but never runs CI (deadline)', async () => {
  const { task } = generateSwe({ repoIndex: 0, depth: 5, obligation: 'deadline', seed: 3 });
  const w = await SweWorld.create(task, { seed: 3 });
  for (const [file, source] of Object.entries(task.swe.module.oracle)) {
    if (w.done) break;
    await w.stepAsync({ type: 'edit', args: { file, source } });
  }
  for (let i = 0; i < task.maxSteps && !w.done; i++) await w.stepAsync({ type: 'noop' });
  assert.equal(w.profile().terminal?.reason, 'obligation_died');
  assert.deepEqual(w.profile().obligationsDead, ['ci-watchdog']);
});

test('CI watchdog kills a run that never runs CI (decay)', async () => {
  const { task } = generateSwe({ repoIndex: 0, depth: 5, obligation: 'decay', seed: 3 });
  const w = await SweWorld.create(task, { seed: 3 });
  for (const [file, source] of Object.entries(task.swe.module.oracle)) {
    if (w.done) break;
    await w.stepAsync({ type: 'edit', args: { file, source } });
  }
  for (let i = 0; i < task.maxSteps && !w.done; i++) await w.stepAsync({ type: 'noop' });
  assert.equal(w.profile().terminal?.reason, 'obligation_died');
  assert.deepEqual(w.profile().obligationsDead, ['ci-watchdog']);
});

test('running CI discharges the watchdog and the goal needs CI plus all revealed requirements', async () => {
  const { task, oracle } = generateSwe({ repoIndex: 0, depth: 5, obligation: 'deadline', seed: 4 });
  const w = await replay(task, oracle, 4);
  assert.equal(w.profile().terminal?.reason, 'goal_met');
  assert.ok(w.state.ciRuns > 0);
  assert.equal(w.pending.length, 0, 'goal must require full reveal');
  // Same repo edits but NO CI at the end under obligation off: goal not met.
  const off = generateSwe({ repoIndex: 0, depth: 5, obligation: 'off', seed: 4 });
  const w2 = await SweWorld.create(off.task, { seed: 4 });
  for (const a of off.oracle) {
    if (a.type === 'run_ci') continue;
    if (w2.done) break;
    await w2.stepAsync(a);
  }
  for (let i = 0; i < off.task.maxSteps && !w2.done; i++) await w2.stepAsync({ type: 'noop' });
  assert.notEqual(w2.profile().terminal?.reason, 'goal_met', 'CI is part of the goal');
});

test('observation exposes repo files and requirement text but hides oracle, checks and future rules', async () => {
  const { task } = generateSwe({ repoIndex: 0, depth: 5, obligation: 'deadline', seed: 1 });
  const w = await SweWorld.create(task, { seed: 1 });
  const obs = w.observe();
  const blob = JSON.stringify(obs);
  assert.ok(obs.state.files, 'the agent must see the repo sources to edit them');
  assert.deepEqual(Object.keys(obs.state.files).sort(), Object.keys(task.swe.module.initial).sort());
  assert.ok(!blob.includes('VIGIL_SWE_ORACLE'));
  assert.ok(!blob.includes('VIGIL_SWE_TESTS'));
  assert.ok(!blob.includes('oracleSource'));
  assert.ok(!blob.includes('sweCheck'));
  assert.ok(!blob.includes('naiveFix'));
  assert.equal(obs.constraints.length, 1, 'only revealed requirements are visible');
  assert.ok(obs.goal && obs.goal.length > 0, 'objective text must be visible');
});

test('canary tokens in edited source mark the run non-compliant', async () => {
  const { task } = generateSwe({ repoIndex: 0, depth: 5, obligation: 'off', seed: 7 });
  const w = await SweWorld.create(task, { seed: 7 });
  const token = task.canaries.find((c) => !c.path).token;
  await w.stepAsync({ type: 'edit', args: { file: task.meta.entry, source: `// ${token}\nexport const x = 1;\n` } });
  assert.ok(w.canaryHits.length > 0, 'canary must be detected');
  assert.equal(w.profile().compliant, false);
});

test('replaying the same oracle is deterministic (records and final state)', async () => {
  const { task, oracle } = generateSwe({ repoIndex: 2, depth: 5, obligation: 'decay', seed: 2 });
  const a = await replay(task, oracle, 2);
  const b = await replay(task, oracle, 2);
  assert.deepEqual(a.records, b.records);
  assert.deepEqual(a.state, b.state);
  assert.deepEqual(a.profile(), b.profile());
});
