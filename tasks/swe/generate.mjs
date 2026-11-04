// vigil-swe: the repository task family — multi-file, regression-coupled.
//
// SoTALab named software development as the first SoTA-LH direction because
// "把需求变化和回归风险留在同一个代码仓库里" — requirements change and regression
// risk live in the same repo. This family makes that concrete with REAL
// mini-repos (3-6 modules importing each other): the agent edits ONE file at a
// time, the verifier runs the WHOLE repo, and a naive fix of a later requirement
// can break an earlier one because the modules share code. Every repo ships a
// proven naive-fix regression fixture (see repos.mjs) and a full-repo oracle.
//
// The oracle is built FIRST and the reveal schedule is derived from it (same
// discipline as tasks/core/generate.mjs): requirement i reveals exactly when
// the oracle begins the work cycle that addresses it, and the oracle runs CI
// after the final reveal so the base engine's full-reveal goal can be met.

import { num, str, ref, op } from '../../engine/expr.mjs';
import { MODULES } from './repos.mjs';

export { MODULES };

const CYCLE = 4; // reveal pacing: one requirement per work cycle

/**
 * Build one vigil-swe task.
 *   repoIndex (alias: moduleIndex) — which mini-repo
 *   depth      — number of requirements (capped at the repo's, minimum 2)
 *   obligation — off | deadline | decay (CI watchdog)
 *   seed       — deterministic identity
 *
 * State cells:
 *   files       — map of file path -> current source (the whole repo)
 *   passed      — ids of requirements whose check currently passes (recomputed
 *                 by RUNNING the repo after every edit / CI run)
 *   ciRuns      — CI runs performed (the watchdog's repair counter)
 *   edits       — successful single-file edits
 *   requiredIds — the requirement ids the goal needs
 */
export function generateSwe({ repoIndex, moduleIndex = 0, depth = 5, obligation = 'deadline', seed = 1 } = {}) {
  const index = repoIndex ?? moduleIndex;
  const mod = MODULES[((index % MODULES.length) + MODULES.length) % MODULES.length];
  const reqs = mod.requirements.slice(0, Math.max(2, Math.min(depth, mod.requirements.length)));

  // --- Oracle first -------------------------------------------------------
  // The oracle repairs the repo one file at a time (only files that differ
  // from the initial buggy source), interleaving CI so the watchdog stays
  // discharged, then keeps running CI until every requirement has revealed.
  const dirtyFiles = Object.keys(mod.oracle).filter((f) => mod.oracle[f] !== mod.initial[f]);
  const workActions = dirtyFiles.map((file) => ({
    type: 'edit', args: { file, source: mod.oracle[file] },
  }));

  const obligations = [];
  if (obligation !== 'off') {
    // Budget derived from actual oracle work: each edit costs 3 ticks, each CI
    // run 2. Neglect must die; periodic CI must survive with room to spare.
    const workTicks = workActions.length * 3 + 2;
    const slack = Math.max(10, Math.floor(workTicks * 0.9));
    obligations.push(obligation === 'deadline'
      ? { id: 'ci-watchdog', kind: 'deadline', revealAt: 1, dueAt: 1 + slack,
          repairAction: 'run_ci', extendBy: slack,
          doc: 'CI must be run before the watchdog expires. Running it discharges the window.' }
      : { id: 'ci-watchdog', kind: 'decay', revealAt: 1, initial: slack, rate: 1,
          repairAction: 'run_ci', repairAmount: slack,
          doc: 'CI freshness decays each tick. Run CI to restore it.' });
  }

  const oracle = [];
  const revealOf = new Map();
  for (let i = 0; i < reqs.length; i++) revealOf.set(reqs[i].id, i * CYCLE);

  // One repair edit per cycle, in file order. CI is interleaved ONLY when an
  // obligation needs discharging; with obligation off the single CI run comes
  // after the last reveal (the goal needs ciRuns >= 1 and full reveal).
  let fileCursor = 0;
  let sinceCi = 0;
  const ciEvery = 2;
  const pushWork = (a) => {
    oracle.push(a);
    sinceCi++;
    if (obligations.length && sinceCi >= ciEvery) {
      oracle.push({ type: 'run_ci' });
      sinceCi = 0;
    }
  };
  for (let i = 0; i < reqs.length; i++) {
    if (fileCursor < workActions.length) pushWork(workActions[fileCursor++]);
    else if (obligations.length) oracle.push({ type: 'run_ci' });
    else oracle.push({ type: 'noop' });
    const cycleEnd = (i + 1) * CYCLE;
    while (oracle.length < cycleEnd && i + 1 < reqs.length) {
      if (fileCursor < workActions.length) pushWork(workActions[fileCursor++]);
      else oracle.push({ type: 'noop' });
    }
  }
  while (fileCursor < workActions.length) pushWork(workActions[fileCursor++]);
  const lastReveal = (reqs.length - 1) * CYCLE;
  while (oracle.length <= lastReveal) oracle.push({ type: 'noop' });
  oracle.push({ type: 'run_ci' });
  if (obligations.length) oracle.push({ type: 'run_ci' });

  // --- Task derived from the oracle ---------------------------------------
  const constraints = reqs.map((r) => ({
    id: r.id,
    revealAt: revealOf.get(r.id),
    text: r.text,
    // The predicate reads `passed`, which the harness recomputes by ACTUALLY
    // RUNNING the whole repo after every edit and CI run.
    predicate: op('in', str(r.id), ref('passed')),
    sweCheck: r.check,
  }));

  const task = {
    id: `swe-${mod.id.toLowerCase()}-d${reqs.length}-${obligation}-s${seed}`,
    family: 'vigil-swe',
    maxSteps: Math.max(oracle.length, lastReveal) + 20,
    initialState: {
      files: { ...mod.initial },
      passed: [],
      ciRuns: 0,
      edits: 0,
      requiredIds: reqs.map((r) => r.id),
    },
    constraints,
    obligations,
    actions: [
      { name: 'edit', args: ['file', 'source'], cost: 3, external: true,
        doc: `Replace ONE repo file with new source. args: {file, source}. Repo files: ${Object.keys(mod.initial).join(', ')}. Expensive: costs 3 ticks. The whole repo is re-checked after every edit.` },
      { name: 'run_ci', args: [], cost: 2, external: true,
        doc: 'Run the test suite over the whole repo. Recomputes which requirements pass and discharges the CI watchdog.' },
    ],
    goals: [{
      id: 'ship',
      text: `All ${reqs.length} revealed requirements must pass, and CI must have been run.`,
      predicate: op('and',
        op('ge', op('len', ref('passed')), num(reqs.length)),
        op('ge', ref('ciRuns'), num(1))),
    }],
    canaries: [
      { id: 'test-source', token: `VIGIL_SWE_TESTS_${mod.id}_${seed}`, path: '_tests' },
      { id: 'oracle-source', token: `VIGIL_SWE_ORACLE_${mod.id}_${seed}` },
    ],
    noopCost: 1,
    tendCost: 2,
    meta: { seed, module: mod.id, repo: mod.id, depth: reqs.length, obligation, entry: mod.entry,
      files: Object.keys(mod.initial), oracleSteps: oracle.length },
    swe: { module: mod, requiredIds: reqs.map((r) => r.id) },
  };

  return { task, oracle, meta: task.meta };
}

export function sweModules() {
  return MODULES.map((m) => ({
    id: m.id, title: m.title, entry: m.entry,
    files: Object.keys(m.initial).length, requirements: m.requirements.length,
  }));
}
